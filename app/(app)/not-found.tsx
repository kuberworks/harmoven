// app/(app)/not-found.tsx
// 404 page for authenticated routes.
// Displayed by Next.js when notFound() is called inside any (app)/ segment,
// e.g. from ProjectPage when the project doesn't exist.

import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { FolderOpen } from 'lucide-react'

export default function NotFound() {
  return (
    <div className="flex flex-1 items-center justify-center py-20">
      <div className="flex flex-col items-center gap-4 text-center max-w-sm">
        <FolderOpen className="h-8 w-8 text-muted-foreground opacity-50" />
        <div>
          <h2 className="text-sm font-semibold text-foreground mb-1">Page not found</h2>
          <p className="text-xs text-muted-foreground">
            The resource you're looking for doesn't exist or you don't have access.
          </p>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link href="/dashboard">Back to Dashboard</Link>
        </Button>
      </div>
    </div>
  )
}
