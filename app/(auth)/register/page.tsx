// app/(auth)/register/page.tsx — Server component
// Gates public self-registration based on security.allow_public_signup
// in orchestrator.yaml (default: false = closed).
// Override: HARMOVEN_ALLOW_PUBLIC_SIGNUP=true env var.

import type { Metadata } from 'next'
import Link from 'next/link'
import { Lock } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { isPublicSignupAllowed } from '@/lib/auth/signup-policy'
import { RegisterForm } from './register-form'

export const metadata: Metadata = { title: 'Create account — Harmoven' }

export default function RegisterPage() {
  const open = isPublicSignupAllowed()

  if (!open) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Lock className="h-4 w-4 text-muted-foreground" />
            <CardTitle>Registration closed</CardTitle>
          </div>
          <CardDescription>
            This instance does not allow public sign-ups.
            Contact your administrator to get access.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-center text-xs text-muted-foreground">
            Already have an account?{' '}
            <Link href="/login" className="text-[var(--accent-amber-9)] hover:underline">
              Sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    )
  }

  return <RegisterForm />
}
