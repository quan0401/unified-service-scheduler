/**
 * Applies migrations to the integration database before the suite runs.
 *
 * `migrate deploy` rather than `migrate reset`: deploy is non-destructive, and
 * per-test isolation is handled by TRUNCATE in `resetData()` instead. Nothing
 * here can drop a database, so pointing TEST_DATABASE_URL at the wrong host
 * cannot destroy data.
 *
 * Migrations are applied rather than `db push` on purpose: the exclusion
 * constraints exist only in hand-written migration SQL, and they are the
 * guarantee this suite validates. Pushing the Prisma schema alone would create
 * tables with no constraints and every concurrency test would pass vacuously.
 */
import { execSync } from 'node:child_process';
import { config } from 'dotenv';

export default function globalSetup(): void {
  config({ path: '.env', quiet: true });

  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error('TEST_DATABASE_URL is not set. Copy .env.example to .env.');
  }
  if (!/scheduler_test/.test(testUrl)) {
    throw new Error(
      `TEST_DATABASE_URL must point at a dedicated test database, got: ${testUrl}`,
    );
  }

  execSync('pnpm prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: testUrl },
  });

  process.env.DATABASE_URL = testUrl;
}
