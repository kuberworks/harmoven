'use client'
// app/(auth)/login/two-factor/totp-challenge-client.tsx
// Inline TOTP code entry — shown after credentials login when 2FA is required.
// No Dialog, no layout chrome — rendered directly inside (auth)/layout.tsx.

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Loader2, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useT } from '@/lib/i18n/client'
import { authClient } from '@/lib/auth-client'

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
      // Use the official Better Auth twoFactor client — it handles the session
      // cookie correctly via the SDK's own cookie management layer instead of
      // raw fetch which has unreliable Set-Cookie behaviour on redirect chains.
      const { error: verifyError } = await (authClient as Record<string, unknown> & { twoFactor: { verifyTotp: (data: { code: string }, opts?: { onSuccess?: () => void }) => Promise<{ error: { status?: number } | null }> } }).twoFactor.verifyTotp(
        { code },
        { onSuccess: () => { window.location.href = callbackURL } },
      )
      if (verifyError) {
        if ((verifyError as { status?: number }).status === 429) {
          setError(t('auth.totp_rate_limit'))
        } else {
          setError(t('auth.totp_invalid'))
        }
        setCode('')
      }
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
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void handleVerify(e as unknown as React.FormEvent) } }}
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
            onClick={() => { window.location.href = '/login' }}
            className="w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {t('auth.totp_back_to_login')}
          </button>
        </form>
      </CardContent>
    </Card>
  )
}
