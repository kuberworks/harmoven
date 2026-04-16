// app/(app)/loading.tsx
// Global loading UI for the authenticated shell.
// Displayed by Next.js App Router while the layout's async Server Components
// (auth check, DB calls) are pending. Enables streaming — the HTML shell
// (sidebar, topbar chrome) is sent immediately; this spinner fills the <main>.

export default function AppLoading() {
  return (
    <div className="flex flex-1 items-center justify-center py-20" aria-busy="true" aria-label="Loading…">
      <div className="flex flex-col items-center gap-3">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-surface-border border-t-[var(--accent-amber-9)]" />
        <p className="text-xs text-muted-foreground">Loading…</p>
      </div>
    </div>
  )
}
