// babel.config.js — used by jest via babel-jest transform
// Standard setup: @babel/preset-env targets current Node, @babel/preset-typescript strips types.
// @babel/preset-react is included for component tests (jsx transform).
module.exports = {
  presets: [
    // Target current Node version — handles module transform (ESM → CJS) + syntax features
    ['@babel/preset-env', { targets: { node: 'current' } }],
    // Strips TypeScript types (babel does NOT type-check — use tsc for that)
    '@babel/preset-typescript',
    // JSX transform for React component tests
    ['@babel/preset-react', { runtime: 'automatic' }],
  ],
}
