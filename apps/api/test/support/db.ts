/**
 * Raw Prisma client bound explicitly to TEST_DATABASE_URL.
 *
 * The URL is passed to the constructor rather than inherited from the ambient
 * DATABASE_URL so a misconfigured environment fails loudly instead of quietly
 * running the destructive suite against the development database.
 */
import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';

config({ path: '.env', quiet: true });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. Copy .env.example to .env.');

export const testDb = new PrismaClient({ datasources: { db: { url } } });

/** Truncates every domain table, leaving the schema and constraints intact. */
export async function resetData(): Promise<void> {
  await testDb.$executeRawUnsafe(`
    TRUNCATE TABLE
      "outbox_event", "appointment", "vehicle", "customer",
      "technician_shift", "technician_skill", "technician",
      "bay_capability", "service_bay", "opening_hour",
      "service_type", "dealership"
    RESTART IDENTITY CASCADE
  `);
}
