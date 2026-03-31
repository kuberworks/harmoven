'use client'

// Search input + pagination controls for the projects list.
// Navigates via URL search params — server component handles the query.

import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { useCallback, useTransition } from 'react'
import { Search, ChevronLeft, ChevronRight, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

// ─── Search ──────────────────────────────────────────────────────────────────

export function ProjectSearch({ defaultValue }: { defaultValue: string }) {
  const router       = useRouter()
  const pathname     = usePathname()
  const searchParams = useSearchParams()
  const [, startTransition] = useTransition()

  const navigate = useCallback(
    (q: string) => {
      const params = new URLSearchParams(searchParams.toString())
      if (q) params.set('q', q)
      else params.delete('q')
      params.delete('page') // reset page on new search
      startTransition(() => router.replace(`${pathname}?${params.toString()}`))
    },
    [router, pathname, searchParams],
  )

  return (
    <div className="relative w-full sm:w-64">
      <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
      <Input
        defaultValue={defaultValue}
        onChange={(e) => navigate(e.target.value)}
        placeholder="Search projects…"
        className="pl-8 h-8 text-xs"
      />
    </div>
  )
}

// ─── Sortable column header ───────────────────────────────────────────────────

export type SortField = 'updated_at' | 'created_at' | 'name' | 'runs' | 'cost'

interface SortHeaderProps {
  field:        SortField
  label:        string
  currentSort:  SortField
  currentOrder: 'asc' | 'desc'
  className?:   string
}

export function SortHeader({ field, label, currentSort, currentOrder, className = '' }: SortHeaderProps) {
  const router       = useRouter()
  const pathname     = usePathname()
  const searchParams = useSearchParams()

  const isActive = currentSort === field
  const nextOrder = isActive && currentOrder === 'desc' ? 'asc' : 'desc'

  function handleClick() {
    const params = new URLSearchParams(searchParams.toString())
    params.set('sort', field)
    params.set('order', nextOrder)
    params.delete('page')
    router.replace(`${pathname}?${params.toString()}`)
  }

  const Icon = !isActive ? ArrowUpDown : currentOrder === 'desc' ? ArrowDown : ArrowUp

  return (
    <th className={`px-3 py-2 text-left ${className}`}>
      <button
        onClick={handleClick}
        className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground uppercase tracking-[0.06em] hover:text-foreground transition-colors group"
      >
        {label}
        <Icon className={`h-3 w-3 ${isActive ? 'text-foreground' : 'opacity-40 group-hover:opacity-70'}`} />
      </button>
    </th>
  )
}

// ─── Page size picker ─────────────────────────────────────────────────────────

export const PAGE_SIZES = [10, 20, 50, 100] as const
export type  PageSize   = typeof PAGE_SIZES[number]

export function PageSizePicker({ currentSize }: { currentSize: number }) {
  const router       = useRouter()
  const pathname     = usePathname()
  const searchParams = useSearchParams()

  function pick(size: number) {
    const params = new URLSearchParams(searchParams.toString())
    if (size === 20) params.delete('size') // 20 is default — keep URL clean
    else params.set('size', String(size))
    params.delete('page')
    router.replace(`${pathname}?${params.toString()}`)
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-muted-foreground">Show</span>
      {PAGE_SIZES.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => pick(s)}
          className={`text-[11px] px-1.5 py-0.5 rounded border transition-colors ${
            s === currentSize
              ? 'border-accent-amber text-accent-amber bg-accent-amber/10'
              : 'border-surface-border text-muted-foreground hover:text-foreground hover:border-foreground/30'
          }`}
        >
          {s}
        </button>
      ))}
    </div>
  )
}

// ─── Pagination ───────────────────────────────────────────────────────────────

interface PaginationProps {
  page:        number
  totalPages:  number
  total:       number
  pageSize:    number
}

export function Pagination({ page, totalPages, total, pageSize }: PaginationProps) {
  const router       = useRouter()
  const pathname     = usePathname()
  const searchParams = useSearchParams()

  function go(p: number) {
    const params = new URLSearchParams(searchParams.toString())
    if (p === 1) params.delete('page')
    else params.set('page', String(p))
    router.replace(`${pathname}?${params.toString()}`)
  }

  const from = (page - 1) * pageSize + 1
  const to   = Math.min(page * pageSize, total)

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 border-t border-surface-border">
      <div className="flex items-center gap-4">
        <span className="text-[11px] text-muted-foreground">
          {total === 0 ? '0 results' : `${from}–${to} of ${total}`}
        </span>
        <PageSizePicker currentSize={pageSize} />
      </div>
      {totalPages > 1 && (
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            className="h-7 w-7 p-0"
            disabled={page <= 1}
            onClick={() => go(page - 1)}
            aria-label="Previous page"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          {Array.from({ length: totalPages }, (_, i) => i + 1)
            .filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 1)
            .reduce<(number | '…')[]>((acc, p, i, arr) => {
              if (i > 0 && typeof arr[i - 1] === 'number' && (p as number) - (arr[i - 1] as number) > 1) acc.push('…')
              acc.push(p)
              return acc
            }, [])
            .map((p, i) =>
              p === '…' ? (
                <span key={`ellipsis-${i}`} className="text-[11px] text-muted-foreground px-1">…</span>
              ) : (
                <Button
                  key={p}
                  size="sm"
                  variant={p === page ? 'default' : 'outline'}
                  className="h-7 w-7 p-0 text-xs"
                  onClick={() => go(p as number)}
                >
                  {p}
                </Button>
              ),
            )}
          <Button
            size="sm"
            variant="outline"
            className="h-7 w-7 p-0"
            disabled={page >= totalPages}
            onClick={() => go(page + 1)}
            aria-label="Next page"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  )
}
