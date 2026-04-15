'use client'
// app/(auth)/login/two-factor/totp-challenge-client.tsx
// Inline TOTP code entry — shown after credentials login when 2FA is required.
// No Dialog, no layout chrome — rendered directly inside (auth)/layout.tsx.

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Loader2, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useT } from '@/lib/i18n/client'

/**
 * getSafeCallbackURL — same guard as login-form.tsx.
 * Only allows same-origin relative paths that start with '/'.
 * Prevents open-redirect via /%2F/evil.com or javascript: URIs.
 */
function getSafeCallbackURL(raw: string | null): string {
  if (!raw) return '/dashboard'
  try {
    const decoded = decodeURIComponent(raw)
    if (!decoded.startsWith('/') || decoded.startsWith('//')) return '/dashboard'
    if (/^\/login(\/|$)/.test(decoded) || /^\/register(\/|$)/.test(decoded)) return '/dashboard'
    return decoded
  } catch {
    return '/dashboard'
  }
}

export function TotpChallengeClient() {
  const t = useT()
  const router = useRouter()
  const searchParams = useSearchParams()

  const callbackURL = getSafeCallbackURL(searchParams.get('callbackURL'))

  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault()
    if (code.length !== 6 || loading) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/two-factor/verify-totp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        // Prevent silent redirect-following: if Better Auth returns a 302,
        // we want res.status = 0 (opaqueredirect) not a silently-followed 200.
        redirect: 'manual',
        body: JSON.stringify({ code }),
      })

      // Better Auth returns a 302 to callbackURL on success and sets the session
      // cookie in that same response. With redirect:'manual' the 302 becomes
      // opaqueredirect. router.replace() is a client-side navigation that fires
      // before the browser commits Set-Cookie headers from the opaque response —
      // the middleware then sees no session cookie and redirects to /login.
      // window.location.href is a full page reload that only runs after all
      // cookie writes from the current response are committed.
      if (res.type === 'opaqueredirect' || res.status === 0) {
        window.location.href = callbackURL
        return
      }

      if (res.status === 429) {
        setError(t('auth.totp_rate_limit'))
        setCode('')
        return
      }

      if (!res.ok) {
        // Wrong code (401) or any other server error
        setError(t('auth.totp_invalid'))
        setCode('')
        return
      }

      // Success — navigate to the intended page
      router.replace(callbackURL)
    } catch {
      setError(t('auth.totp_invalid'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card className="w-full max-w-[380px]">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" aria-hidden />
          {t('auth.totp_title')}
        </CardTitle>
        <CardDescription>{t('auth.totp_prompt')}</CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={handleVerify} className="space-y-4">
          <div className="space-y-1.5">
            <Input
              placeholder="000000"
              maxLength={6}
              value={code}
              onChange={e => {
                setCode(e.target.value.replace(/\D/g, ''))
                if (error) setError(null)
              }}
              autoComplete="one-time-code"
              inputMode="numeric"
              aria-invalid={error !== null}
              aria-describedby={error ? 'totp-error' : undefined}
              className="text-2xl tracking-[0.4em] font-mono text-center h-14"
              autoFocus
            />
            {error && (
              <p id="totp-error" role="alert" className="text-sm font-medium text-destructive">
                {error}
              </p>
            )}
          </div>
          <Button className="w-full" type="submit" disabled={loading || code.length !== 6}>
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('auth.totp_submit')}
          </Button>
          <button
            type="button"
            onClick={() => router.push('/login')}
            className="w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {t('auth.totp_back_to_login')}
          </button>
        </form>
      </CardContent>
    </Card>
  )
}
