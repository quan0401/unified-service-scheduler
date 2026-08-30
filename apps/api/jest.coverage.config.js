/**
 * Combined coverage across both suites.
 *
 * Reporting unit-test coverage alone would be misleading: most behaviour in
 * this service is emergent -- SQL semantics, constraint enforcement, retry
 * under contention -- and is only exercised against a real database. A number
 * drawn from the pure-logic tests would look like thin coverage of a
 * well-tested system.
 *
 * Requires a live PostgreSQL, same as the integration suite.
 */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/test/**/*.e2e-spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  globalSetup: '<rootDir>/test/global-setup.ts',
  testTimeout: 120000,
  collectCoverage: true,
  collectCoverageFrom: [
    'src/**/*.ts',
    // Wiring, not logic: these are covered transitively by every request the
    // integration suite makes, and asserting on them directly would test Nest.
    '!src/**/*.module.ts',
    '!src/main.ts',
    '!src/openapi.ts',
    '!src/observability/tracing.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text-summary', 'text', 'lcov'],
};
