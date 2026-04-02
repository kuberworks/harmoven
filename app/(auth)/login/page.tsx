// app/(auth)/login/page.tsx — Server component
// Reads allow_public_signup to conditionally show the "Create account" link.

import type { Metadata } from 'next'
import { isPublicSignupAllowed } from '@/lib/auth/signup-policy'
import { LoginForm } from './login-form'

export const metadata: Metadata = { title: 'Sign in — Harmoven' }

export default function LoginPage() {
  const allowSignup = isPublicSignupAllowed()
  return <LoginForm allowSignup={allowSignup} />
}
