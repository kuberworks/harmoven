// jest.config.js
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  transform: {
    // Include .mjs so babel-jest can transpile ESM-only packages (e.g. better-auth)
    '^.+\\.(ts|tsx|mjs|js)$': ['babel-jest', { configFile: './babel.jest.js' }],
  },
  moduleNameMapper: {
    // Map @/* path alias to project root (mirrors tsconfig.json paths)
    '^@/(.*)$': '<rootDir>/$1',
    // better-auth/crypto ships as ESM-only (.mjs). Jest's CJS mode cannot
    // require() .mjs files. Map to a CJS shim with the same exports.
    '^better-auth/crypto$': '<rootDir>/__mocks__/better-auth-crypto.cjs',
  },
  testMatch: [
    '<rootDir>/tests/**/*.test.ts',
    '<rootDir>/tests/**/*.test.tsx',
  ],
  // Do not transform node_modules EXCEPT packages that ship ESM-only.
  // better-auth (and its sub-packages) use .mjs entry points that Node's CJS
  // loader cannot require — babel-jest must transpile them to CJS.
  transformIgnorePatterns: ['/node_modules/(?!(better-auth|@better-auth)/)'],
  // Longer timeout for integration tests wiring real LLM
  testTimeout: 30000,
}
