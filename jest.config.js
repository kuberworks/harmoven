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
  // unified / remark / micromark / mdast / unist / vfile / hast ecosystem are
  // also ESM-only and must be transpiled by babel-jest.
  transformIgnorePatterns: [
    '/node_modules/(?!(better-auth|@better-auth|unified|remark-[^/]+|micromark[^/]*|mdast-[^/]+|unist-[^/]+|vfile[^/]*|hast-[^/]+|bail|trough|is-plain-obj|ccount|comma-separated-tokens|space-separated-tokens|property-information|html-void-elements|decode-named-character-reference|character-entities[^/]*|zwitch|longest-streak|stringify-entities|hastscript|devlop)/)',
  ],
  // Longer timeout for integration tests wiring real LLM
  testTimeout: 30000,
}
