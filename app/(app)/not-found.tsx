// app/(app)/not-found.tsx
// 404 page for authenticated routes.
// Displayed by Next.js when notFound() is called inside any (app)/ segment,
// e.g. from ProjectPage when the project doesn't exist.
// Split from "access denied" case: access denied redirects to /dashboard with a toast.

import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { SearchX } from 'lucide-react'

export default function NotFound() {
  return (
    <div className="flex flex-1 items-center justify-center py-20">
      <div className="flex flex-col items-center gap-4 text-center max-w-sm">
        <SearchX className="h-8 w-8 text-muted-foreground opacity-50" />
        <div>
          <h2 className="text-sm font-semibold text-foreground mb-1">Resource not found</h2>
          <p className="text-xs text-muted-foreground">
            This page doesn&apos;t exist or has been deleted.
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            If you expected to see something here, check that the link is correct.
          </p>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link href="/dashboard">Back to Dashboard</Link>
        </Button>
      </div>
    </div>
  )
}
