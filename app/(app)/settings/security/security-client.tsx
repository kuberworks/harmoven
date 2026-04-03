'use client'

// app/(app)/settings/security/security-client.tsx
// TOTP, passkeys, and active sessions management.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
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
  Shield, Smartphone, Key, Globe, Loader2, Trash2, Plus, CheckCircle2,
} from 'lucide-react'

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
  const t = useT()

  const [sessions, setSessions] = useState(initialSessions)
  const [passkeys, setPasskeys] = useState(initialPasskeys)
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null)
  const [revoking, setRevoking] = useState(false)
  const [addingPasskey, setAddingPasskey] = useState(false)

  async function revokeSession(id: string) {
    setRevoking(true)
    try {
      await authClient.revokeSession({ token: id })
      setSessions((s) => s.filter((x) => x.id !== id))
      toast({ title: 'Session revoked' })
      setRevokeTarget(null)
    } catch {
      toast({ title: 'Failed to revoke session', variant: 'destructive' })
    } finally {
      setRevoking(false)
    }
  }

  async function revokeAllOther() {
    setRevoking(true)
    try {
      await authClient.revokeOtherSessions()
      setSessions((s) => s.filter((x) => x.current))
      toast({ title: 'All other sessions revoked' })
    } catch {
      toast({ title: 'Failed to revoke sessions', variant: 'destructive' })
    } finally {
      setRevoking(false)
    }
  }

  async function addPasskey() {
    setAddingPasskey(true)
    try {
      await authClient.passkey?.addPasskey()
      toast({ title: 'Passkey added' })
      router.refresh()
    } catch {
      toast({ title: 'Failed to add passkey', variant: 'destructive' })
    } finally {
      setAddingPasskey(false)
    }
  }

  async function removePasskey(id: string) {
    try {
      await authClient.passkey?.deletePasskey({ id })
      setPasskeys((p) => p.filter((x) => x.id !== id))
      toast({ title: 'Passkey removed' })
    } catch {
      toast({ title: 'Failed to remove passkey', variant: 'destructive' })
    }
  }

  const otherSessions = sessions.filter((s) => !s.current)

  return (
    <div className="space-y-6 animate-stagger">
      {/* TOTP */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Smartphone className="h-4 w-4 text-muted-foreground" aria-hidden />
            Two-factor authentication
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-foreground">{t('settings.authenticator_app')}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Use an app like 1Password, Authy or Google Authenticator.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {totpEnabled ? (
                <Badge variant="completed">Enabled</Badge>
              ) : (
                <Badge variant="pending">Disabled</Badge>
              )}
            </div>
          </div>
          {totpEnabled ? (
            <p className="text-xs text-muted-foreground border border-surface-border rounded-lg px-3 py-2 bg-surface-raised">
              TOTP is managed via your account settings on the authentication provider used to sign in.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Enable two-factor authentication for an additional layer of security.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Passkeys */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-base">
            <span className="flex items-center gap-2">
              <Key className="h-4 w-4 text-muted-foreground" aria-hidden />
              Passkeys
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={addPasskey}
              disabled={addingPasskey}
              className="h-7 text-xs gap-1"
            >
              {addingPasskey ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Add passkey
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {passkeys.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">
              No passkeys registered. Passkeys let you sign in without a password using biometrics or a security key.
            </p>
          ) : (
            <ul className="divide-y divide-surface-border">
              {passkeys.map((pk) => (
                <li key={pk.id} className="flex items-center justify-between py-2.5 gap-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">{pk.name || 'Unnamed passkey'}</p>
                    <p className="text-xs text-muted-foreground">{t('settings.passkey_added_on', { date: formatDate(pk.createdAt) })}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 gap-1"
                    onClick={() => removePasskey(pk.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Remove
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
              Active sessions
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
                Revoke all other sessions
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
                        Current
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground font-mono mt-0.5">
                    {s.ipAddress ?? 'unknown IP'} · Last active {formatDate(s.updatedAt)}
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
                    Revoke
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
              Revoke session
            </DialogTitle>
            <DialogDescription>
              This will immediately sign out the device associated with this session. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRevokeTarget(null)}>Cancel</Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => revokeTarget && revokeSession(revokeTarget)}
              disabled={revoking}
            >
              {revoking && <Loader2 className="h-4 w-4 animate-spin" />}
              Revoke session
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
