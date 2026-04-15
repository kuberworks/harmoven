'use client'
// app/mfa-setup/mfa-setup-client.tsx
// Inline 4-step TOTP wizard for the dedicated MFA setup page.
// No Dialog — the wizard IS the page, rendered inside a Card.
// Steps: password → scan → codes → verify

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { QRCodeCanvas } from 'qrcode.react'
import { cn } from '@/lib/utils/cn'
import { authClient } from '@/lib/auth-client'
import { useT } from '@/lib/i18n/client'
import { useToast } from '@/components/ui/use-toast'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Loader2, Shield } from 'lucide-react'

type Step = 'password' | 'scan' | 'codes' | 'verify'
const STEPS: Step[] = ['password', 'scan', 'codes', 'verify']

export function MfaSetupClient() {
  const t = useT()
  const router = useRouter()
  const { toast } = useToast()

  const [step, setStep] = useState<Step>('password')
  const [password, setPassword] = useState('')
  const [totpUri, setTotpUri] = useState<string | null>(null)
  const [backupCodes, setBackupCodes] = useState<string[]>([])
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [showManualKey, setShowManualKey] = useState(false)

  const stepIndex = STEPS.indexOf(step)

  // ── Step 0: password ──────────────────────────────────────────────
  async function handlePasswordNext() {
    if (!password) return
    setLoading(true)
    try {
      const res = await fetch('/api/auth/two-factor/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password }),
      })
      if (res.status === 401 || res.status === 403) {
        toast({ variant: 'destructive', title: t('settings.totp_wrong_password'), description: t('settings.totp_wrong_password_desc') })
        return
      }
      if (!res.ok) {
        toast({ variant: 'destructive', title: t('settings.totp_setup_error'), description: t('settings.totp_setup_error_desc') })
        return
      }
      const data = await res.json() as { totpURI: string; backupCodes: string[] }
      setTotpUri(data.totpURI ?? null)
      setBackupCodes(data.backupCodes ?? [])
      setStep('scan')
    } catch {
      toast({ variant: 'destructive', title: t('settings.totp_setup_error'), description: t('settings.totp_network_error') })
    } finally {
      setLoading(false)
    }
  }

  // ── Step 3: verify ────────────────────────────────────────────────
  async function handleVerify() {
    if (code.length !== 6) return
    setLoading(true)
    try {
      const res = await fetch('/api/auth/two-factor/verify-totp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ code }),
      })
      if (!res.ok) {
        toast({ variant: 'destructive', title: t('settings.totp_code_invalid'), description: t('settings.totp_code_invalid_desc') })
        return
      }
      toast({ title: t('settings.totp_activated'), description: t('settings.totp_activated_desc') })
      router.replace('/dashboard')
    } catch {
      toast({ variant: 'destructive', title: t('settings.totp_setup_error'), description: t('settings.totp_network_error') })
    } finally {
      setLoading(false)
    }
  }

  async function handleSignOut() {
    await authClient.signOut().catch(() => null)
    router.replace('/login')
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          <Shield className="h-5 w-5 text-amber-400" aria-hidden />
          {t('mfa_setup.page_title')}
        </CardTitle>
        <CardDescription>{t('mfa_setup.page_subtitle')}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-5 pt-2">
        {/* Progress bar */}
        <div className="flex gap-1.5" aria-hidden>
          {STEPS.map((s, i) => (
            <div
              key={s}
              className={cn(
                'h-1 flex-1 rounded-full transition-colors duration-300',
                i <= stepIndex ? 'bg-primary' : 'bg-surface-border',
              )}
            />
          ))}
        </div>

        {/* ── Step 0: Password ── */}
        {step === 'password' && (
          <div className="space-y-4">
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">{t('settings.totp_step_password_title')}</p>
              <p className="text-xs text-muted-foreground">{t('settings.totp_step_password_desc')}</p>
            </div>
            <Input
              type="password"
              placeholder={t('settings.totp_password_placeholder')}
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && password) handlePasswordNext() }}
              autoComplete="current-password"
              className="h-11"
              autoFocus
            />
            <Button className="w-full" onClick={handlePasswordNext} disabled={loading || !password}>
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('settings.totp_password_next')}
            </Button>
          </div>
        )}

        {/* ── Step 1: Scan QR ── */}
        {step === 'scan' && (
          <div className="space-y-4">
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">{t('settings.totp_step_scan_title')}</p>
              <p className="text-xs text-muted-foreground">{t('settings.totp_scan_instruction')}</p>
            </div>
            <div className="flex justify-center">
              <div className="bg-white rounded-lg p-3 shadow-sm">
                <QRCodeCanvas value={totpUri ?? ''} size={180} level="M" marginSize={1} />
              </div>
            </div>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline transition-colors w-full text-center"
              onClick={() => setShowManualKey(v => !v)}
            >
              {showManualKey ? t('settings.totp_manual_hide') : t('settings.totp_manual_show')}
            </button>
            {showManualKey && (
              <code className="block text-xs bg-surface-raised border border-surface-border rounded px-2 py-1.5 break-all text-center font-mono">
                {totpUri?.match(/secret=([^&]+)/)?.[1] ?? ''}
              </code>
            )}
            <Button className="w-full" onClick={() => setStep('codes')}>
              {t('settings.totp_scan_next')}
            </Button>
          </div>
        )}

        {/* ── Step 2: Backup codes ── */}
        {step === 'codes' && (
          <div className="space-y-4">
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">{t('settings.totp_step_codes_title')}</p>
              <p className="text-xs text-muted-foreground">{t('settings.totp_backup_desc')}</p>
            </div>
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
              <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                {backupCodes.map(c => (
                  <code key={c} className="text-xs font-mono text-amber-300 tracking-wider">{c}</code>
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" className="flex-1" onClick={() => setStep('scan')}>
                {t('settings.totp_back')}
              </Button>
              <Button className="flex-1" onClick={() => { setCode(''); setStep('verify') }}>
                {t('settings.totp_codes_ack')}
              </Button>
            </div>
          </div>
        )}

        {/* ── Step 3: Verify ── */}
        {step === 'verify' && (
          <div className="space-y-4">
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">{t('settings.totp_step_verify_title')}</p>
              <p className="text-xs text-muted-foreground">{t('settings.totp_enter_code_hint')}</p>
            </div>
            <Input
              placeholder="000000"
              maxLength={6}
              value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
              onKeyDown={e => { if (e.key === 'Enter' && code.length === 6) handleVerify() }}
              autoComplete="one-time-code"
              inputMode="numeric"
              className="text-2xl tracking-[0.4em] font-mono text-center h-14"
              autoFocus
            />
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" className="flex-1" onClick={() => setStep('codes')}>
                {t('settings.totp_back')}
              </Button>
              <Button className="flex-1" onClick={handleVerify} disabled={loading || code.length !== 6}>
                {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('settings.totp_confirm_cta')}
              </Button>
            </div>
          </div>
        )}

        {/* Sign out escape hatch */}
        <button
          type="button"
          onClick={handleSignOut}
          className="w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors pt-1"
        >
          {t('mfa_setup.signout')}
        </button>
      </CardContent>
    </Card>
  )
}
