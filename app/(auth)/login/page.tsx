// app/(auth)/login/page.tsx — Server component
// Reads allow_public_signup to conditionally show the "Create account" link.

import { Suspense } from 'react'
import type { Metadata } from 'next'
import { isPublicSignupAllowed } from '@/lib/auth/signup-policy'
import { LoginForm } from './login-form'

export const metadata: Metadata = { title: 'Sign in — Harmoven' }

export default function LoginPage() {
  const allowSignup = isPublicSignupAllowed()
  // Suspense is required: LoginForm uses useSearchParams() which opts out of
  // static rendering — without this boundary the whole page is deferred and
  // React event handlers may not hydrate correctly on first paint.
  return (
    <Suspense>
      <LoginForm allowSignup={allowSignup} />
    </Suspense>
  )
}
