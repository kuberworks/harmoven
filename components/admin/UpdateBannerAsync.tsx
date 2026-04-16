'use client'

// components/admin/UpdateBannerAsync.tsx
// Async wrapper: fetches update info client-side, renders UpdateBanner when an update exists.
// The existing UpdateBanner expects updateInfo as a prop; this component feeds it.

import { useEffect, useState } from 'react'
import { UpdateBanner } from '@/components/admin/UpdateBanner'
import type { UpdateCheckResult } from '@/lib/updates/types'
import type { MigrationPreview } from '@/lib/updates/types'

type FullUpdateInfo = UpdateCheckResult & { migrationPreview: MigrationPreview }

export function UpdateBannerAsync() {
  const [updateInfo, setUpdateInfo] = useState<FullUpdateInfo | null>(null)

  useEffect(() => {
    fetch('/api/updates')
      .then(r => r.ok ? r.json() : null)
      .then((data: FullUpdateInfo | null) => {
        if (data?.hasUpdate) setUpdateInfo(data)
      })
      .catch(() => { /* non-fatal */ })
  }, [])

  if (!updateInfo) return null
  return <UpdateBanner updateInfo={updateInfo} />
}
