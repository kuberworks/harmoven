'use client'

// app/(auth)/login/login-form.tsx — Client component
// Login form extracted from page.tsx so the parent server component
// can read allow_public_signup and pass it as a prop.

import { useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { KeyRound, Loader2, Fingerprint } from 'lucide-react'
import { authClient } from '@/lib/auth-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useToast } from '@/components/ui/use-toast'

/** Passkey runtime type — added by passkeyClient at runtime, not in base typings. */
type PasskeySignIn = (opts?: Record<string, unknown>) => Promise<{ error?: { message?: string } | null }>

/**
 * Return a safe landing URL after login.
 * Only accepts same-origin relative paths (starts with '/') to prevent open redirect.
 * Strips the callbackURL if it points at /login or /register (loop guard).
 */
function getSafeCallbackURL(raw: string | null): string {
  if (!raw) return '/dashboard'
  // SEC-H-03: Percent-decode before validating to prevent bypasses like
  // callbackURL=/%2F/evil.com which starts with '/' but decodes to '//evil.com'.
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return '/dashboard'
  }
  if (decoded.startsWith('/') && !decoded.startsWith('//')) {
    const blocked = ['/login', '/register']
    if (!blocked.some(b => decoded === b || decoded.startsWith(b + '?'))) {
      return decoded
    }
  }
  return '/dashboard'
}

interface Props { allowSignup: boolean }

export function LoginForm({ allowSignup }: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { toast } = useToast()

  const callbackURL = getSafeCallbackURL(searchParams.get('callbackURL'))

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isPendingEmail, setIsPendingEmail] = useState(false)
  const [isPendingPasskey, setIsPendingPasskey] = useState(false)

  // ── Email + password ──────────────────────────────────────────────
  async function handlePasswordLogin(e: React.FormEvent) {
    e.preventDefault()
    if (isPendingEmail) return
    setIsPendingEmail(true)
    try {
      const { error } = await authClient.signIn.email({
        email,
        password,
        callbackURL,
      })
      if (error) {
        toast({
          variant: 'destructive',
          title: 'Sign in failed',
          description: error.message ?? 'Invalid email or password',
        })
      } else {
        router.push(callbackURL)
      }
    } catch {
      toast({ variant: 'destructive', title: 'Sign in failed', description: 'An unexpected error occurred.' })
    } finally {
      setIsPendingEmail(false)
    }
  }

  // ── Passkey ───────────────────────────────────────────────────────
  async function handlePasskey() {
    if (isPendingPasskey) return
    setIsPendingPasskey(true)
    try {
      const signInPasskey = (authClient.signIn as Record<string, unknown>).passkey as PasskeySignIn | undefined
      if (!signInPasskey) {
        toast({ variant: 'destructive', title: 'Passkey not available', description: 'Configure @better-auth/passkey on the server.' })
        return
      }
      const { error } = await signInPasskey()
      if (error) {
        toast({ variant: 'destructive', title: 'Passkey sign in failed', description: error.message })
      } else {
        router.push(callbackURL)
      }
    } catch {
      toast({ variant: 'destructive', title: 'Passkey sign in failed', description: 'An unexpected error occurred.' })
    } finally {
      setIsPendingPasskey(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Enter your credentials to continue</CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Email + password — primary method */}
        <form
          onSubmit={handlePasswordLogin}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.target instanceof HTMLInputElement && !isPendingEmail) {
              e.preventDefault()
              e.currentTarget.requestSubmit()
            }
          }}
          className="space-y-3"
        >
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
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
              <span className="text-xs text-muted-foreground">Forgot? Contact your administrator.</span>
            </div>
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
          <Button type="submit" className="w-full" disabled={isPendingEmail}>
            {isPendingEmail ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            Sign in
          </Button>
        </form>

        {/* Passkey — secondary option */}
        <div className="relative">
          <Separator />
          <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-2 text-xs text-muted-foreground">
            or
          </span>
        </div>

        <Button
          type="button"
          variant="outline"
          className="w-full gap-2"
          onClick={handlePasskey}
          disabled={isPendingPasskey}
        >
          {isPendingPasskey ? <Loader2 className="h-4 w-4 animate-spin" /> : <Fingerprint className="h-4 w-4" />}
          Sign in with passkey
        </Button>

        {allowSignup && (
          <p className="text-center text-xs text-muted-foreground">
            <Link href="/register" className="text-[var(--accent-amber-9)] hover:underline">
              Create account
            </Link>
          </p>
        )}
      </CardContent>
    </Card>
  )
}
