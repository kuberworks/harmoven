// app/(app)/error.tsx
// Error boundary for the authenticated app shell.
// Caught by Next.js when any Server Component inside (app)/ throws.
// Prevents a DB or auth error from leaking a raw Next.js error page
// (which can expose stack traces in production).
//
// Must be a Client Component (Next.js requirement for error.tsx).

'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { AlertTriangle } from 'lucide-react'

interface ErrorBoundaryProps {
  error: Error & { digest?: string }
  reset: () => void
}

export default function AppError({ error, reset }: ErrorBoundaryProps) {
  useEffect(() => {
    // Log to console in dev; replace with your error tracking service (Sentry etc.)
    console.error('[AppError boundary]', error)
  }, [error])

  return (
    <div className="flex flex-1 items-center justify-center py-20">
      <div className="flex flex-col items-center gap-4 text-center max-w-sm">
        <AlertTriangle className="h-8 w-8 text-destructive opacity-70" />
        <div>
          <h2 className="text-sm font-semibold text-foreground mb-1">Something went wrong</h2>
          <p className="text-xs text-muted-foreground">
            An unexpected error occurred. The team has been notified.
          </p>
          {error.digest && (
            <p className="mt-1 text-xs text-muted-foreground font-mono opacity-60">
              Error ID: {error.digest}
            </p>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={reset}>
          Try again
        </Button>
      </div>
    </div>
  )
}
