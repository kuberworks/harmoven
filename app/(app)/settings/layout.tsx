// app/(app)/settings/layout.tsx
// Shared layout for all /settings/* pages — adds the tab navigation bar.

import { SettingsNav } from './settings-nav'

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SettingsNav />
      {children}
    </>
  )
}
