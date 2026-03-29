// lib/auth-client.ts
// Better Auth client — use in Client Components only.
// Never import this in Server Components; use `lib/auth.ts` directly.
// Note: twoFactorClient excluded (type incompatibility with current better-auth version);
//       TOTP flows use direct fetch('/api/auth/two-factor/verify-totp').
import { createAuthClient } from 'better-auth/client'
import { passkeyClient } from '@better-auth/passkey/client'

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_AUTH_URL ?? '',
  plugins: [
    passkeyClient(),
  ],
})

export type Session = Awaited<ReturnType<typeof authClient.getSession>>['data']
