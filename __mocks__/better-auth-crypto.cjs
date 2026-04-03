// __mocks__/better-auth-crypto.cjs
// CJS shim for better-auth/crypto — used only by Jest (CJS mode).
//
// better-auth ships `better-auth/crypto` as ESM-only (.mjs). In Jest's default
// CJS mode the native require() cannot load .mjs files, causing every test that
// imports a route handler using hashPassword/verifyPassword to fail at module
// load time. This shim re-exports the same names as no-op stubs so the module
// resolves. Route handler tests that exercise POST /admin/users (which calls
// hashPassword) should mock this explicitly if they need a specific return value.
//
// Exports mirror better-auth/dist/crypto/index.mjs:
//   constantTimeEqual, formatEnvelope, generateRandomString, getCryptoKey,
//   hashPassword, makeSignature, parseEnvelope, signJWT,
//   symmetricDecodeJWT, symmetricDecrypt, symmetricEncodeJWT, symmetricEncrypt,
//   verifyJWT, verifyPassword

module.exports = {
  constantTimeEqual:   jest.fn().mockReturnValue(true),
  formatEnvelope:      jest.fn().mockReturnValue(''),
  generateRandomString: jest.fn().mockReturnValue('mock-random'),
  getCryptoKey:        jest.fn().mockResolvedValue(null),
  hashPassword:        jest.fn().mockResolvedValue('mock-hashed-password'),
  makeSignature:       jest.fn().mockResolvedValue('mock-signature'),
  parseEnvelope:       jest.fn().mockReturnValue(null),
  signJWT:             jest.fn().mockResolvedValue('mock-jwt'),
  symmetricDecodeJWT:  jest.fn().mockResolvedValue(null),
  symmetricDecrypt:    jest.fn().mockResolvedValue(''),
  symmetricEncodeJWT:  jest.fn().mockResolvedValue('mock-encoded-jwt'),
  symmetricEncrypt:    jest.fn().mockResolvedValue(''),
  verifyJWT:           jest.fn().mockResolvedValue(null),
  verifyPassword:      jest.fn().mockResolvedValue(true),
}
