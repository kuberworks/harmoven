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
import { useToast } from '@/components/ui/use-toast'
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
  const { toast } = useToast()

  const callbackURL = getSafeCallbackURL(searchParams.get('callbackURL'))

  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault()
    if (code.length !== 6 || loading) return
    setLoading(true)
    try {
      const res = await fetch('/api/auth/two-factor/verify-totp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ code }),
      })
      if (!res.ok) {
        toast({
          variant: 'destructive',
          title: t('auth.totp_invalid'),
          description: t('settings.totp_code_invalid_desc'),
        })
        setCode('')
        return
      }
      router.replace(callbackURL)
    } catch {
      toast({
        variant: 'destructive',
        title: t('settings.totp_setup_error'),
        description: t('settings.totp_network_error'),
      })
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
          <Input
            placeholder="000000"
            maxLength={6}
            value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
            autoComplete="one-time-code"
            inputMode="numeric"
            className="text-2xl tracking-[0.4em] font-mono text-center h-14"
            autoFocus
          />
          <Button className="w-full" type="submit" disabled={loading || code.length !== 6}>
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('auth.totp_submit')}
          </Button>
          <button
            type="button"
            onClick={() => router.push('/login')}
            className="w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {t('settings.totp_back')}
          </button>
        </form>
      </CardContent>
    </Card>
  )
}
