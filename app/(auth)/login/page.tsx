'use client'

// app/(auth)/login/page.tsx
// Login screen — email/password and passkey (magic link deferred: needs server plugin).
// Spec: FRONTEND-SDD-PROMPT.md Priority 1, UX.md §3.1, SKILLS.md §3.

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { KeyRound, Loader2, Fingerprint } from 'lucide-react'
import { authClient } from '@/lib/auth-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useToast } from '@/components/ui/use-toast'

export default function LoginPage() {
  const router = useRouter()
  const { toast } = useToast()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isPending, startTransition] = useTransition()

  // ── Email + password ──────────────────────────────────────────────
  function handlePasswordLogin(e: React.FormEvent) {
    e.preventDefault()
    startTransition(async () => {
      const { error } = await authClient.signIn.email({
        email,
        password,
        callbackURL: '/dashboard',
      })
      if (error) {
        toast({
          variant: 'destructive',
          title: 'Sign in failed',
          description: error.message ?? 'Invalid email or password',
        })
      } else {
        router.push('/dashboard')
      }
    })
  }

  // ── Passkey ───────────────────────────────────────────────────────
  function handlePasskey() {
    startTransition(async () => {
      // passkeyClient adds signIn.passkey at runtime; cast for TypeScript
      type PasskeySignIn = (opts?: Record<string, unknown>) => Promise<{ error?: { message?: string } | null }>
      const signInPasskey = (authClient.signIn as Record<string, unknown>).passkey as PasskeySignIn | undefined
      if (!signInPasskey) {
        toast({ variant: 'destructive', title: 'Passkey not available', description: 'Configure @better-auth/passkey on the server.' })
        return
      }
      const { error } = await signInPasskey()
      if (error) {
        toast({ variant: 'destructive', title: 'Passkey sign in failed', description: error.message })
      } else {
        router.push('/dashboard')
      }
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Enter your credentials to continue</CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Passkey — primary CTA */}
        <Button
          variant="outline"
          className="w-full gap-2"
          onClick={handlePasskey}
          disabled={isPending}
        >
          {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Fingerprint className="h-4 w-4" />}
          Sign in with passkey
        </Button>

        <div className="relative">
          <Separator />
          <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-2 text-xs text-muted-foreground">
            or continue with email
          </span>
        </div>

        {/* Email + password */}
        <form onSubmit={handlePasswordLogin} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
            />
          </div>
          <Button type="submit" className="w-full" disabled={isPending}>
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            Sign in
          </Button>
        </form>

        <p className="text-center text-xs text-muted-foreground">
          New instance?{' '}
          <Link href="/setup" className="text-[var(--accent-amber-9)] hover:underline">
            Run setup wizard
          </Link>
          {' · '}
          <Link href="/register" className="text-[var(--accent-amber-9)] hover:underline">
            Create account
          </Link>
        </p>
      </CardContent>
    </Card>
  )
}
