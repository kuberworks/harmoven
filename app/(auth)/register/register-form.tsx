'use client'

// app/(auth)/register/register-form.tsx — Client component
// Registration form extracted from page.tsx so the parent server component
// can gate access before rendering this.

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { UserPlus, Loader2 } from 'lucide-react'
import { authClient } from '@/lib/auth-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useToast } from '@/components/ui/use-toast'

/** Returns a 0–4 strength score for the given password. */
function passwordStrength(pw: string): { score: number; label: string; color: string } {
  if (pw.length === 0) return { score: 0, label: '',          color: '' }
  if (pw.length < 8)   return { score: 1, label: 'Too short', color: 'bg-red-500' }
  let score = 1
  if (/[A-Z]/.test(pw)) score++
  if (/[0-9]/.test(pw)) score++
  if (/[^A-Za-z0-9]/.test(pw)) score++
  const label = score <= 1 ? 'Weak' : score === 2 ? 'Fair' : score === 3 ? 'Good' : 'Strong'
  const color = score <= 1 ? 'bg-red-500' : score === 2 ? 'bg-amber-500' : score === 3 ? 'bg-blue-500' : 'bg-emerald-500'
  return { score, label, color }
}

export function RegisterForm() {
  const router = useRouter()
  const { toast } = useToast()

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isPending, startTransition] = useTransition()

  const strength = passwordStrength(password)
  const mismatch = confirmPassword.length > 0 && confirmPassword !== password

  function handleRegister(e: React.FormEvent) {
    e.preventDefault()
    if (password !== confirmPassword) {
      toast({ variant: 'destructive', title: 'Passwords do not match', description: 'Please make sure both fields are identical.' })
      return
    }
    startTransition(async () => {
      const { error } = await authClient.signUp.email({
        name,
        email,
        password,
        callbackURL: '/dashboard',
      })
      if (error) {
        toast({
          variant: 'destructive',
          title: 'Registration failed',
          description: error.message ?? 'Could not create account',
        })
      } else {
        toast({ title: 'Account created', description: 'Check your inbox to verify your email.' })
        router.push('/login')
      }
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create an account</CardTitle>
        <CardDescription>Enter your details to get started</CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={handleRegister} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="name">Full name</Label>
            <Input
              id="name"
              type="text"
              autoComplete="name"
              placeholder="Marie Dupont"
              value={name}
              onChange={e => setName(e.target.value)}
              required
            />
          </div>
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
              autoComplete="new-password"
              placeholder="Min. 8 characters"
              minLength={8}
              value={password}
              onChange={e => setPassword(e.target.value)}
              aria-describedby="password-strength"
              required
            />
            {password.length > 0 && (
              <div id="password-strength" className="space-y-1">
                <div className="flex gap-1 h-1">
                  {[1, 2, 3, 4].map(i => (
                    <div
                      key={i}
                      className={`flex-1 rounded-full transition-colors ${i <= strength.score ? strength.color : 'bg-muted'}`}
                    />
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">{strength.label}</p>
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="confirm-password">Confirm password</Label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              placeholder="Repeat your password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              aria-describedby={mismatch ? 'confirm-password-error' : undefined}
              aria-invalid={mismatch}
              required
            />
            {mismatch && (
              <p id="confirm-password-error" role="alert" className="text-[11px] text-destructive">
                Passwords do not match.
              </p>
            )}
          </div>
          <Button type="submit" className="w-full" disabled={isPending || mismatch}>
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
            Create account
          </Button>

          <p className="text-center text-xs text-muted-foreground">
            Already have an account?{' '}
            <Link href="/login" className="text-[var(--accent-amber-9)] hover:underline">
              Sign in
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  )
}
