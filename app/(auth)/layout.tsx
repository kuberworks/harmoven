// app/(auth)/layout.tsx
// Auth shell — centered card layout, dark mesh background, no nav.
// Used by: /login, /register, /login/check-email
// Note: no shared metadata here — each child page defines its own title.

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-surface-base">
      {/* Subtle warm gradient mesh — DESIGN_SYSTEM.md "depth in hero surfaces" */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        <div className="absolute -left-1/4 -top-1/4 h-[600px] w-[600px] rounded-full bg-[var(--accent-amber-3)] opacity-30 blur-[120px]" />
        <div className="absolute -bottom-1/4 -right-1/4 h-[400px] w-[400px] rounded-full bg-[var(--accent-amber-3)] opacity-20 blur-[100px]" />
      </div>

      {/* Wordmark */}
      <div className="mb-8 flex flex-col items-center select-none animate-fade-in">
        <span className="text-2xl font-bold tracking-tight text-foreground">
          Harmo<span className="text-[var(--accent-amber-9)]">ven</span>
        </span>
        <span className="mt-0.5 text-xs text-muted-foreground">AI orchestration platform</span>
      </div>

      {/* Card */}
      <div className="relative z-10 w-full max-w-[400px] px-4 animate-fade-in">
        {children}
      </div>

      <p className="mt-8 text-center text-xs text-muted-foreground">
        &copy; {new Date().getFullYear()} Harmoven
      </p>
    </div>
  )
}
