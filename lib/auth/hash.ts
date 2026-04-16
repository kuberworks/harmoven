// lib/auth/hash.ts
// Password hashing utility — delegates directly to better-auth's own crypto layer.
// Used only by prisma/seed.ts for the admin bootstrap.
// All other password operations go through the Better Auth HTTP API.
//
// Using better-auth/crypto guarantees that passwords hashed here are verified
// correctly by better-auth's credential provider (same algorithm, same format).

import { hashPassword as baHashPassword, verifyPassword } from 'better-auth/crypto'

export { hashPassword, verifyPassword }

/** Hash a password using better-auth's internal algorithm (argon2id). */
async function hashPassword(password: string): Promise<string> {
  return baHashPassword(password)
}
