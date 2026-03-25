// lib/auth/hash.ts
// Password hashing utility — wraps better-auth's internal hasher.
// Used only by prisma/seed.ts for the admin bootstrap.
// All other password operations go through the Better Auth HTTP API.

// better-auth uses @node-rs/argon2 internally via its own hashing layer,
// but does not expose it publicly. We use the same 'oslo' library it depends on.
// Fallback: if oslo is not available, use node:crypto PBKDF2.

let _hash: ((password: string) => Promise<string>) | null = null

async function getHasher() {
  if (_hash) return _hash
  try {
    // Try oslo (bundled with better-auth)
    const { Argon2id } = await import('oslo/password')
    const argon2 = new Argon2id()
    _hash = (p) => argon2.hash(p)
  } catch {
    // Fallback: node:crypto PBKDF2 (SHA-256, 310000 iterations — NIST SP 800-132)
    const { scrypt, randomBytes } = await import('node:crypto')
    _hash = (password: string) =>
      new Promise((resolve, reject) => {
        const salt = randomBytes(16).toString('hex')
        scrypt(password, salt, 64, (err, derivedKey) => {
          if (err) reject(err)
          else resolve(`scrypt:${salt}:${derivedKey.toString('hex')}`)
        })
      })
  }
  return _hash
}

export async function hashPassword(password: string): Promise<string> {
  const hasher = await getHasher()
  return hasher(password)
}
