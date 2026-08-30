/** Integration tests: require a live PostgreSQL 16 with btree_gist. */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.e2e-spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  // Resolve the contracts package to its source, not its build output. Jest has
  // no rootDir constraint, so it can do what tsc must not -- and tests then
  // cannot pass against a stale dist/.
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@scheduler/contracts$': '<rootDir>/../../packages/contracts/src',
  },
  globalSetup: '<rootDir>/test/global-setup.ts',
  testTimeout: 120000,
};
