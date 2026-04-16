// lib/bootstrap/validate-argon2-memory.ts
// Startup check for Argon2id memory configuration (Am.92 §8).
//
// The spec requires:
//   - Docker mode:   65 536 KB (64 MB)
//   - Electron mode: 19 456 KB (19 MB)
//   - Override:      ARGON2_MEMORY_KB env var
//
// Better Auth 1.5.x does not expose a runtime Argon2 memory API, so we set
// the process.env.ARGON2_MEMORY_KB variable that the underlying argon2 package
// reads when performing hash operations, and log a warning if misconfigured.

export function validateArgon2Memory(): void {
  const explicit = process.env.ARGON2_MEMORY_KB
  if (explicit) {
    const kb = parseInt(explicit, 10)
    if (isNaN(kb) || kb < 8192) {
      console.warn(
        `[argon2] ARGON2_MEMORY_KB=${explicit} is below 8 192 KB minimum.`
        + ' Risk: brute-force resistance reduced.',
      )
    }
    console.info(`[argon2] Memory cost: ${kb} KB (explicit ARGON2_MEMORY_KB)`)
    return
  }

  const mode = process.env.DEPLOYMENT_MODE ?? 'docker'
  const targetKb = mode === 'electron' ? 19456 : 65536

  // Propagate to process.env so the argon2 package picks it up at hash time.
  process.env.ARGON2_MEMORY_KB = String(targetKb)

  console.info(
    `[argon2] Memory cost: ${targetKb} KB`
    + ` (DEPLOYMENT_MODE=${mode}, Am.92 §8)`,
  )
}
