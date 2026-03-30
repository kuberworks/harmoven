// jest.config.js
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.(ts|tsx)$': ['babel-jest', { configFile: './babel.jest.js' }],
  },
  moduleNameMapper: {
    // Map @/* path alias to project root (mirrors tsconfig.json paths)
    '^@/(.*)$': '<rootDir>/$1',
  },
  testMatch: [
    '<rootDir>/tests/**/*.test.ts',
    '<rootDir>/tests/**/*.test.tsx',
  ],
  // Do not transform node_modules (use CommonJS directly)
  transformIgnorePatterns: ['/node_modules/'],
  // Longer timeout for integration tests wiring real LLM
  testTimeout: 30000,
}
