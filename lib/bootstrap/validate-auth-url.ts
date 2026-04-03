// lib/bootstrap/validate-auth-url.ts
// Startup check: AUTH_URL port must match HARMOVEN_PORT.
//
// If the user sets HARMOVEN_PORT=3001 but forgets to update AUTH_URL,
// Better Auth will reject all login attempts because the cookie origin won't
// match the trusted origin. This check surfaces the misconfiguration early
// with a clear message instead of a cryptic auth error.
//
// Only runs in Docker-style deployments where HARMOVEN_PORT is meaningful.
// In Electron mode the port is always controlled by the Electron shell.
//
// Returns without throwing — a misconfiguration should not prevent startup,
// but the warning is logged as ERROR to be visible in production logs.

export function validateAuthUrl(): void {
  const authUrl = process.env.AUTH_URL
  const harmonvenPort = process.env.HARMOVEN_PORT

  // Nothing to validate if HARMOVEN_PORT is not explicitly set (default 3000).
  if (!harmonvenPort) return

  // Nothing to validate if AUTH_URL is not set (Better Auth will warn separately).
  if (!authUrl) return

  let parsedPort: string
  try {
    parsedPort = new URL(authUrl).port || '80'
  } catch {
    console.error(
      `[auth-url] AUTH_URL="${authUrl}" is not a valid URL. `
      + 'Better Auth will likely fail. Fix AUTH_URL in .env.',
    )
    return
  }

  // Normalise: if no port in URL but scheme implies one (http→80, https→443)
  const urlObj = new URL(authUrl)
  const effectivePort = urlObj.port || (urlObj.protocol === 'https:' ? '443' : '80')

  if (effectivePort !== harmonvenPort) {
    console.error(
      `[auth-url] Port mismatch: HARMOVEN_PORT=${harmonvenPort} but AUTH_URL="${authUrl}" uses port ${effectivePort}. `
      + `Update AUTH_URL to http://localhost:${harmonvenPort} (or your public hostname) in .env. `
      + 'Mismatched ports will cause auth cookie failures.',
    )
  }
}
