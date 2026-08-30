/**
 * The relay's behaviour when more than one instance is running.
 *
 * Every API replica runs this cron. The property under test is that a batch of
 * pending events is *partitioned* across concurrent relays rather than
 * duplicated into each of them -- what `FOR UPDATE SKIP LOCKED` provides and
 * what an uncoordinated `findMany` does not.
 *
 * Relays are built here with independent PrismaClients rather than taken from
 * the Nest container. The claim is cross-connection: two relays sharing one
 * client would prove nothing about two processes.
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { testDb, resetData } from '../support/db';
import { OutboxRelay, RELAY_BATCH_SIZE } from '../../src/modules/background-jobs/outbox.relay';
import type { PrismaService } from '../../src/prisma/prisma.service';

const REPLICA_COUNT = 4;

/** A relay plus the marker of every event its dispatch actually saw. */
interface Replica {
  relay: OutboxRelay;
  client: PrismaClient;
  dispatched: string[];
}

/** Dispatch is private; the spy reaches it through a narrowed structural type. */
type Dispatchable = { dispatch: (eventType: string, payload: unknown) => Promise<void> };

function createReplica(): Replica {
  const url = process.env.TEST_DATABASE_URL as string;
  const client = new PrismaClient({ datasources: { db: { url } } });
  const relay = new OutboxRelay(client as unknown as PrismaService);
  const dispatched: string[] = [];

  jest
    .spyOn(relay as unknown as Dispatchable, 'dispatch')
    .mockImplementation((_eventType: string, payload: unknown) => {
      dispatched.push((payload as { marker: string }).marker);
      return Promise.resolve();
    });

  return { relay, client, dispatched };
}

/** Seeds `count` unpublished events, each carrying a unique marker. */
async function seedPending(count: number): Promise<string[]> {
  const markers = Array.from({ length: count }, () => randomUUID());
  await testDb.outboxEvent.createMany({
    data: markers.map((marker) => ({
      eventType: 'test.event',
      aggregateId: randomUUID(),
      payload: { marker },
    })),
  });
  return markers;
}

describe('outbox relay', () => {
  let replicas: Replica[];

  beforeEach(async () => {
    await resetData();
    replicas = Array.from({ length: REPLICA_COUNT }, createReplica);
  });

  afterEach(async () => {
    await Promise.all(replicas.map((r) => r.client.$disconnect()));
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await testDb.$disconnect();
  });

  /**
   * The regression test. Against the uncoordinated `findMany` every replica
   * selects the same rows, so this reports REPLICA_COUNT x the seeded count.
   *
   * The seeded count deliberately exceeds RELAY_BATCH_SIZE so the work must be
   * spread over more than one claim -- proving partitioning, not just that a
   * single relay happened to win the whole batch.
   */
  it('dispatches each pending event exactly once across concurrent relays', async () => {
    const seeded = await seedPending(RELAY_BATCH_SIZE * 2 + 50);

    await Promise.all(replicas.map((r) => r.relay.publishPending()));

    const dispatched = replicas.flatMap((r) => r.dispatched);
    expect(dispatched).toHaveLength(seeded.length);
    expect(new Set(dispatched)).toEqual(new Set(seeded));
  });

  it('claims no more than one batch in a single pass', async () => {
    await seedPending(RELAY_BATCH_SIZE + 20);

    await replicas[0].relay.publishPending();

    expect(replicas[0].dispatched).toHaveLength(RELAY_BATCH_SIZE);
    expect(await testDb.outboxEvent.count({ where: { publishedAt: null } })).toBe(20);
  });

  it('marks every dispatched event delivered', async () => {
    await seedPending(5);

    await replicas[0].relay.publishPending();

    expect(await testDb.outboxEvent.count({ where: { publishedAt: null } })).toBe(0);
  });

  /**
   * One unroutable event must not strand the rest of the batch, and must stay
   * pending so the next tick retries it -- the at-least-once contract.
   */
  it('leaves a failed event pending without stalling the batch', async () => {
    const markers = await seedPending(5);
    const doomed = markers[2];
    const { relay, dispatched } = replicas[0];

    jest
      .spyOn(relay as unknown as Dispatchable, 'dispatch')
      .mockImplementation((_eventType: string, payload: unknown) => {
        const marker = (payload as { marker: string }).marker;
        if (marker === doomed) return Promise.reject(new Error('broker unreachable'));
        dispatched.push(marker);
        return Promise.resolve();
      });

    await expect(relay.publishPending()).resolves.toBeUndefined();

    expect(dispatched).toHaveLength(4);
    const pending = await testDb.outboxEvent.findMany({ where: { publishedAt: null } });
    expect(pending).toHaveLength(1);
    expect((pending[0].payload as { marker: string }).marker).toBe(doomed);
    expect(pending[0].attemptCount).toBe(1);
  });

  it('does nothing when there is nothing pending', async () => {
    await replicas[0].relay.publishPending();

    expect(replicas[0].dispatched).toHaveLength(0);
  });
});
