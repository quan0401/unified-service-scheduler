/**
 * Boots the real Nest application against the integration database.
 *
 * The full stack is exercised -- pipes, interceptor, exception filter, and the
 * genuine SQL -- because the behaviour under test is emergent. A mocked
 * repository would prove only that the mock returns what it was told to.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';
import { config } from 'dotenv';

config({ path: '.env', quiet: true });

// Bound before the module is imported: PrismaService reads DATABASE_URL when it
// is constructed, so redirecting it afterwards would silently target the
// development database.
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error('TEST_DATABASE_URL is not set. Copy .env.example to .env.');
process.env.DATABASE_URL = testUrl;

// Concurrency tests deliberately send hundreds of requests from one address.
// The guard stays installed -- only its ceiling is raised -- so a broken
// throttler configuration would still fail at startup.
process.env.THROTTLE_BURST_LIMIT ??= '100000';
process.env.THROTTLE_SUSTAINED_LIMIT ??= '100000';

// Request logging is signal in production and noise in a test run, where a
// concurrency suite would emit hundreds of lines per assertion.
process.env.LOG_LEVEL ??= 'silent';

/* eslint-disable @typescript-eslint/no-var-requires */
import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/domain-exception.filter';
import { ResponseEnvelopeInterceptor } from '../../src/common/response.interceptor';

export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = moduleRef.createNestApplication({ logger: false });
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor(app.get(Reflector)));
  app.useGlobalFilters(new DomainExceptionFilter());

  await app.init();
  // Bind a real port once. Without this, supertest starts an ephemeral listener
  // per request, and a few hundred concurrent calls exhaust sockets with
  // ECONNRESET before any contention is measured.
  await app.listen(0);
  return app;
}
