'use client'

// app/(app)/settings/security/security-client.tsx
// TOTP, passkeys, and active sessions management.

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { Separator } from '@/components/ui/separator'
import { authClient } from '@/lib/auth-client'
import { useT } from '@/lib/i18n/client'
import {
  Shield, Smartphone, Key, Globe, Loader2, Trash2, Plus, CheckCircle2, AlertTriangle,
} from 'lucide-react'
import { QRCodeCanvas } from 'qrcode.react'
import { cn } from '@/lib/utils/cn'

interface SessionRow {
  id: string
  createdAt: string
  updatedAt: string
  ipAddress?: string | null
  userAgent?: string | null
  current: boolean
}

interface PasskeyRow {
  id: string
  name?: string | null
  createdAt: string
}

interface Props {
  sessions: SessionRow[]
  passkeys: PasskeyRow[]
  totpEnabled: boolean
}

function parseBrowser(ua: string | null | undefined): string {
  if (!ua) return 'Unknown browser'
  if (ua.includes('Chrome')) return 'Chrome'
  if (ua.includes('Firefox')) return 'Firefox'
  if (ua.includes('Safari')) return 'Safari'
  if (ua.includes('Edge')) return 'Edge'
  return 'Browser'
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function SecurityClient({ sessions: initialSessions, passkeys: initialPasskeys, totpEnabled }: Props) {
  const { toast } = useToast()
  const router = useRouter()
  const searchParams = useSearchParams()
  const t = useT()
  const setupMfa = searchParams.get('setup_mfa') === '1'

  const [sessions, setSessions] = useState(initialSessions)
  const [passkeys, setPasskeys] = useState(initialPasskeys)
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null)
  const [revoking, setRevoking] = useState(false)
  const [addingPasskey, setAddingPasskey] = useState(false)

  // ── TOTP setup state ──────────────────────────────────────────────
  const [totpDialogOpen, setTotpDialogOpen] = useState(false)
  const [totpStep, setTotpStep] = useState<'password' | 'scan' | 'codes' | 'verify'>('password')
  const [totpUri, setTotpUri] = useState<string | null>(null)
  const [totpBackupCodes, setTotpBackupCodes] = useState<string[]>([])
  const [totpCode, setTotpCode] = useState('')
  const [totpPassword, setTotpPassword] = useState('')
  const [totpLoading, setTotpLoading] = useState(false)
  const [showManualKey, setShowManualKey] = useState(false)

  // Sync passkeys state when the server re-renders with fresh data after router.refresh().
  // useState(initialPasskeys) only reads the prop once on mount, so without this effect
  // the list never updates after a passkey is added.
  useEffect(() => { setPasskeys(initialPasskeys) }, [initialPasskeys])

  // ── TOTP setup handlers ───────────────────────────────────────────
  /** Initiate TOTP setup: generates secret + backup codes, returns totpURI */
  async function getTotpUri(password: string): Promise<{ totpURI: string; backupCodes: string[] } | null> {
    const res = await fetch('/api/auth/two-factor/enable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ password }),
    })
    if (res.status === 401 || res.status === 403) {
      toast({ variant: 'destructive', title: t('settings.totp_wrong_password'), description: t('settings.totp_wrong_password_desc') })
      return null
    }
    if (!res.ok) {
      toast({ variant: 'destructive', title: t('settings.totp_setup_error'), description: t('settings.totp_setup_error_desc') })
      return null
    }
    return res.json() as Promise<{ totpURI: string; backupCodes: string[] }>
  }

  function openTotpWizard() {
    setTotpPassword('')
    setTotpCode('')
    setTotpStep('password')
    setShowManualKey(false)
    setTotpUri(null)
    setTotpBackupCodes([])
    setTotpDialogOpen(true)
  }

  async function handlePasswordNext() {
    if (!totpPassword) return
    setTotpLoading(true)
    try {
      const data = await getTotpUri(totpPassword)
      if (!data) return
      setTotpUri(data.totpURI ?? null)
      setTotpBackupCodes(data.backupCodes ?? [])
      setShowManualKey(false)
      setTotpStep('scan')
    } finally {
      setTotpLoading(false)
    }
  }

  async function verifyAndEnableTotp() {
    if (!totpCode || totpCode.length !== 6) return
    setTotpLoading(true)
    try {
      const res = await fetch('/api/auth/two-factor/verify-totp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ code: totpCode }),
      })
      if (!res.ok) {
        toast({ variant: 'destructive', title: t('settings.totp_code_invalid'), description: t('settings.totp_code_invalid_desc') })
        return
      }
      toast({ title: t('settings.totp_activated'), description: t('settings.totp_activated_desc') })
      setTotpDialogOpen(false)
      router.refresh()
      // If we were redirected here by the MFA enforcement, go to dashboard.
      if (setupMfa) router.replace('/dashboard')
    } catch {
      toast({ variant: 'destructive', title: t('settings.totp_setup_error'), description: t('settings.totp_network_error') })
    } finally {
      setTotpLoading(false)
    }
  }

  async function revokeSession(id: string) {
    setRevoking(true)
    try {
      await authClient.revokeSession({ token: id })
      setSessions((s) => s.filter((x) => x.id !== id))
      toast({ title: t('settings.sessions_revoked_toast') })
      setRevokeTarget(null)
    } catch {
      toast({ title: t('settings.sessions_revoke_error'), variant: 'destructive' })
    } finally {
      setRevoking(false)
    }
  }

  async function revokeAllOther() {
    setRevoking(true)
    try {
      await authClient.revokeOtherSessions()
      setSessions((s) => s.filter((x) => x.current))
      toast({ title: t('settings.sessions_revoke_all_toast') })
    } catch {
      toast({ title: t('settings.sessions_revoke_all_error'), variant: 'destructive' })
    } finally {
      setRevoking(false)
    }
  }

  async function addPasskey() {
    setAddingPasskey(true)
    try {
      await authClient.passkey?.addPasskey()
      toast({ title: t('settings.passkey_added_toast') })
      router.refresh()
    } catch {
      toast({ title: t('settings.passkey_add_error'), variant: 'destructive' })
    } finally {
      setAddingPasskey(false)
    }
  }

  async function removePasskey(id: string) {
    try {
      await authClient.passkey?.deletePasskey({ id })
      setPasskeys((p) => p.filter((x) => x.id !== id))
      toast({ title: t('settings.passkey_removed_toast') })
    } catch {
      toast({ title: t('settings.passkey_remove_error'), variant: 'destructive' })
    }
  }

  const otherSessions = sessions.filter((s) => !s.current)

  return (
    <div className="space-y-6 animate-stagger">
      {/* MFA enforcement banner — shown when redirected by middleware */}
      {setupMfa && !totpEnabled && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
          <AlertTriangle className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" aria-hidden />
          <div>
            <p className="font-medium text-amber-300">{t('settings.mfa_required_title')}</p>
            <p className="text-amber-400/80 mt-0.5">{t('settings.mfa_required_desc')}</p>
          </div>
        </div>
      )}

      {/* TOTP */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Smartphone className="h-4 w-4 text-muted-foreground" aria-hidden />
            {t('settings.totp_card_title')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {totpEnabled ? (
            <div className="flex items-center gap-3 rounded-lg border border-green-500/20 bg-green-500/10 px-4 py-3">
              <CheckCircle2 className="h-5 w-5 text-green-400 shrink-0" aria-hidden />
              <div>
                <p className="text-sm font-medium text-green-300">{t('settings.totp_active_title')}</p>
                <p className="text-xs text-green-400/80 mt-0.5">{t('settings.totp_active_desc')}</p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Why */}
              <div className="rounded-lg border border-surface-border bg-surface-raised px-4 py-3 space-y-1">
                <p className="text-sm font-medium text-foreground">{t('settings.totp_why_title')}</p>
                <p className="text-xs text-muted-foreground">{t('settings.totp_why_desc')}</p>
              </div>
              <p className="text-xs text-muted-foreground">{t('settings.totp_app_hint')}</p>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button
                  size="sm"
                  className="h-9 gap-1.5"
                  onClick={openTotpWizard}
                >
                  <Shield className="h-4 w-4" />
                  {t('settings.totp_activate_btn')}
                </Button>
                {totpUri && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-9 text-xs gap-1"
                    onClick={() => { setTotpStep('scan'); setTotpDialogOpen(true) }}
                  >
                    <Smartphone className="h-3.5 w-3.5" />
                    {t('settings.totp_open_qr')}
                  </Button>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Passkeys */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-base">
            <span className="flex items-center gap-2">
              <Key className="h-4 w-4 text-muted-foreground" aria-hidden />
              {t('settings.passkeys')}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={addPasskey}
              disabled={addingPasskey}
              className="h-7 text-xs gap-1"
            >
              {addingPasskey ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              {t('settings.passkey_add')}
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {passkeys.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">
              {t('settings.passkey_none')}
            </p>
          ) : (
            <ul className="divide-y divide-surface-border">
              {passkeys.map((pk) => (
                <li key={pk.id} className="flex items-center justify-between py-2.5 gap-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">{pk.name || t('settings.passkey_unnamed')}</p>
                    <p className="text-xs text-muted-foreground">{t('settings.passkey_added_on', { date: formatDate(pk.createdAt) })}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 gap-1"
                    onClick={() => removePasskey(pk.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {t('settings.passkey_remove')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Sessions */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-base">
            <span className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-muted-foreground" aria-hidden />
              {t('settings.sessions_title')}
            </span>
            {otherSessions.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs border-red-500/30 text-red-400 hover:bg-red-500/10"
                onClick={revokeAllOther}
                disabled={revoking}
              >
                {revoking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {t('settings.sessions_revoke_all')}
              </Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-surface-border">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center justify-between py-2.5 gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="text-sm font-medium text-foreground">{parseBrowser(s.userAgent)}</p>
                    {s.current && (
                      <Badge variant="completed" className="text-xs gap-1">
                        <CheckCircle2 className="h-3 w-3" />
                        {t('settings.sessions_current')}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground font-mono mt-0.5">
                    {s.ipAddress ?? t('settings.sessions_unknown_ip')} · {t('settings.sessions_last_active', { date: formatDate(s.updatedAt) })}
                  </p>
                </div>
                {!s.current && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 gap-1"
                    onClick={() => setRevokeTarget(s.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {t('settings.sessions_revoke_btn')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* Confirm revoke dialog */}
      <Dialog open={!!revokeTarget} onOpenChange={() => setRevokeTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-amber-400" />
              {t('settings.revoke_dialog_title')}
            </DialogTitle>
            <DialogDescription>
              {t('settings.revoke_dialog_desc')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRevokeTarget(null)}>{t('common.cancel')}</Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => revokeTarget && revokeSession(revokeTarget)}
              disabled={revoking}
            >
              {revoking && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('settings.revoke_dialog_confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* TOTP setup dialog — 4-step wizard */}
      <Dialog open={totpDialogOpen} onOpenChange={open => {
        setTotpDialogOpen(open)
        if (!open) { setTotpCode(''); setTotpPassword(''); setShowManualKey(false) }
      }}>
        {/*
          w-[calc(100%-2rem)]: 16px margin on each side on mobile so the dialog
          never touches screen edges. sm:w-full restores normal width on desktop.
          max-h-[90dvh] + overflow-y-auto: prevent overflow on short/small screens.
        */}
        <DialogContent className="w-[calc(100%-2rem)] sm:w-full max-h-[90dvh] overflow-y-auto">
          {/* Progress bar — pr-10 clears the absolute close button (right-4 + icon width) */}
          <div className="flex gap-1.5 mb-4 pr-10" aria-hidden>
            {(['password', 'scan', 'codes', 'verify'] as const).map((s, i) => (
              <div
                key={s}
                className={cn(
                  'h-1 flex-1 rounded-full transition-colors duration-300',
                  (['password', 'scan', 'codes', 'verify'] as const).indexOf(totpStep) >= i
                    ? 'bg-primary'
                    : 'bg-surface-border'
                )}
              />
            ))}
          </div>

          {/* ── Step 0: Password ── */}
          {totpStep === 'password' && <>
            <DialogHeader>
              <DialogTitle>{t('settings.totp_step_password_title')}</DialogTitle>
              <DialogDescription>{t('settings.totp_step_password_desc')}</DialogDescription>
            </DialogHeader>
            {/*
              Wrap in <form> so password managers (1Password, Bitwarden, etc.)
              detect the field and can autofill. Without a <form>, most managers
              don't inject the autofill button on the input.
            */}
            <form
              id="totp-password-form"
              onSubmit={e => { e.preventDefault(); if (totpPassword) handlePasswordNext() }}
              className="space-y-1.5"
            >
              <Label htmlFor="totp-password-input">{t('settings.totp_password_label')}</Label>
              <Input
                id="totp-password-input"
                name="password"
                type="password"
                placeholder={t('settings.totp_password_placeholder')}
                value={totpPassword}
                onChange={e => setTotpPassword(e.target.value)}
                autoComplete="current-password"
                className="h-11"
                autoFocus
              />
            </form>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setTotpDialogOpen(false)}>{t('common.cancel')}</Button>
              <Button
                type="submit"
                form="totp-password-form"
                size="sm"
                disabled={totpLoading || !totpPassword}
              >
                {totpLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('settings.totp_password_next')}
              </Button>
            </DialogFooter>
          </>}

          {/* ── Step 1: Scan ── */}
          {totpStep === 'scan' && <>
            <DialogHeader>
              <DialogTitle>{t('settings.totp_step_scan_title')}</DialogTitle>
              <DialogDescription>{t('settings.totp_scan_instruction')}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col items-center gap-3 py-1">
              <div className="bg-white rounded-lg p-3 shadow-sm">
                <QRCodeCanvas value={totpUri ?? ''} size={160} level="M" marginSize={1} />
              </div>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline transition-colors"
                onClick={() => setShowManualKey(v => !v)}
              >
                {showManualKey ? t('settings.totp_manual_hide') : t('settings.totp_manual_show')}
              </button>
              {showManualKey && (
                <code className="text-xs bg-surface-raised border border-surface-border rounded px-2 py-1.5 break-all w-full text-center font-mono">
                  {totpUri?.match(/secret=([^&]+)/)?.[1] ?? ''}
                </code>
              )}
            </div>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setTotpDialogOpen(false)}>{t('common.cancel')}</Button>
              <Button size="sm" onClick={() => setTotpStep('codes')}>{t('settings.totp_scan_next')}</Button>
            </DialogFooter>
          </>}

          {/* ── Step 2: Backup codes ── */}
          {totpStep === 'codes' && <>
            <DialogHeader>
              <DialogTitle>{t('settings.totp_step_codes_title')}</DialogTitle>
              <DialogDescription>{t('settings.totp_backup_desc')}</DialogDescription>
            </DialogHeader>
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
              <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                {totpBackupCodes.map((code) => (
                  <code key={code} className="text-xs font-mono text-amber-300 tracking-wider">{code}</code>
                ))}
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setTotpStep('scan')}>{t('settings.totp_back')}</Button>
              <Button size="sm" onClick={() => { setTotpCode(''); setTotpStep('verify') }}>{t('settings.totp_codes_ack')}</Button>
            </DialogFooter>
          </>}

          {/* ── Step 3: Verify ── */}
          {totpStep === 'verify' && <>
            <DialogHeader>
              <DialogTitle>{t('settings.totp_step_verify_title')}</DialogTitle>
              <DialogDescription>{t('settings.totp_enter_code_hint')}</DialogDescription>
            </DialogHeader>
            <Input
              id="totp-code"
              placeholder="000000"
              maxLength={6}
              value={totpCode}
              onChange={e => setTotpCode(e.target.value.replace(/\D/g, ''))}
              onKeyDown={e => { if (e.key === 'Enter' && totpCode.length === 6) verifyAndEnableTotp() }}
              autoComplete="one-time-code"
              inputMode="numeric"
              className="text-2xl tracking-[0.4em] font-mono text-center h-14 mt-1"
              autoFocus
            />
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setTotpStep('codes')}>{t('settings.totp_back')}</Button>
              <Button
                size="sm"
                onClick={verifyAndEnableTotp}
                disabled={totpLoading || totpCode.length !== 6}
              >
                {totpLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('settings.totp_confirm_cta')}
              </Button>
            </DialogFooter>
          </>}
        </DialogContent>
      </Dialog>
    </div>
  )
}
