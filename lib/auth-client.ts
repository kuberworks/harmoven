// lib/auth-client.ts
// Better Auth client — use in Client Components only.
// Never import this in Server Components; use `lib/auth.ts` directly.
import { createAuthClient } from 'better-auth/client'
import { passkeyClient } from '@better-auth/passkey/client'
import { twoFactorClient } from 'better-auth/client/plugins'

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_AUTH_URL ?? '',
  plugins: [
    passkeyClient(),
    twoFactorClient() as never,  // eslint-disable-line @typescript-eslint/no-explicit-any
  ],
})

export type Session = Awaited<ReturnType<typeof authClient.getSession>>['data']
