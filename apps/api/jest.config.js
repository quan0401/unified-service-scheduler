/** Unit tests: pure logic only, no database. */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  // Resolve the contracts package to its source, not its build output. Jest has
  // no rootDir constraint, so it can do what tsc must not -- and tests then
  // cannot pass against a stale dist/.
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@scheduler/contracts$': '<rootDir>/../../packages/contracts/src',
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.module.ts', '!src/main.ts'],
  coverageDirectory: 'coverage',
};
