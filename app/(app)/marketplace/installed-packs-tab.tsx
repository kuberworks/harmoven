'use client'

// InstalledPacksTab — searchable, filterable, sortable, paginated list of installed agent skills.
// Shown to all authenticated users. Admin actions (enable/disable/edit/delete) gated on isAdmin.

import { useState, useMemo } from 'react'
import { Input }   from '@/components/ui/input'
import { Badge }   from '@/components/ui/badge'
import { Button }  from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Package,
  Search,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  UploadCloud,
  ShoppingBag,
  HardDrive,
  Cpu,
} from 'lucide-react'
import { SkillActionsClient } from '@/app/(app)/admin/integrations/skill-actions-client'
import { useT } from '@/lib/i18n/client'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InstalledSkill {
  id:              string
  name:            string
  pack_id:         string | null
  source_type:     string
  source_url:      string | null
  source_ref:      string | null
  version:         string | null
  author:          string | null
  tags:            string[]
  capability_type: string | null
  enabled:         boolean
  scan_status:     string
  installed_at:    string           // ISO string — serialized by server
  pending_update:  unknown | null
  approved_by:     string | null
  config:          Record<string, unknown>
}

interface Props {
  skills:  InstalledSkill[]
  isAdmin: boolean
  locale:  string
}

// ─── Styling maps ─────────────────────────────────────────────────────────────

const CAP_CLASS: Record<string, string> = {
  domain_pack:    'bg-purple-500/15 text-purple-400 border-purple-500/30',
  mcp_skill:      'bg-blue-500/15 text-blue-400 border-blue-500/30',
  prompt_only:    'bg-slate-500/15 text-slate-300 border-slate-500/30',
  harmoven_agent: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  js_ts_plugin:   'bg-amber-500/15 text-amber-400 border-amber-500/30',
  slash_command:  'bg-rose-500/15 text-rose-400 border-rose-500/30',
}

const PAGE_SIZE = 15

// ─── Helpers ──────────────────────────────────────────────────────────────────

function SourceIcon({ type }: { type: string }) {
  const cls = 'h-3 w-3 shrink-0'
  if (type === 'git')      return <GitBranch    className={cls} />
  if (type === 'official') return <ShoppingBag  className={cls} />
  if (type === 'upload')   return <UploadCloud  className={cls} />
  if (type === 'local')    return <HardDrive    className={cls} />
  return <Cpu className={cls} />
}

function formatVersion(skill: InstalledSkill): string | null {
  if (skill.source_ref) return skill.source_ref
  if (!skill.version)   return null
  return /^\d/.test(skill.version) ? `v${skill.version}` : skill.version
}

// ─── Component ────────────────────────────────────────────────────────────────

export function InstalledPacksTab({ skills, isAdmin, locale }: Props) {
  const t = useT()

  const [search,       setSearch]       = useState('')
  const [capFilter,    setCapFilter]    = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [sortBy,       setSortBy]       = useState<'installed_at' | 'name' | 'version'>('installed_at')
  const [page,         setPage]         = useState(0)

  // Unique capability types present in the data (for filter options)
  const capTypes = useMemo(
    () => Array.from(new Set(skills.map((s) => s.capability_type).filter(Boolean) as string[])),
    [skills],
  )

  // Filter + sort
  const filtered = useMemo(() => {
    let list = skills

    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.pack_id?.toLowerCase().includes(q)) ||
          (s.author?.toLowerCase().includes(q)) ||
          s.tags.some((tag) => tag.toLowerCase().includes(q)),
      )
    }

    if (capFilter !== 'all') {
      list = list.filter((s) => s.capability_type === capFilter)
    }

    if (statusFilter === 'active')   list = list.filter((s) =>  s.enabled)
    if (statusFilter === 'disabled') list = list.filter((s) => !s.enabled)

    list = [...list].sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name)
      if (sortBy === 'version') {
        const av = formatVersion(a) ?? ''
        const bv = formatVersion(b) ?? ''
        return av.localeCompare(bv)
      }
      // installed_at desc
      return new Date(b.installed_at).getTime() - new Date(a.installed_at).getTime()
    })

    return list
  }, [skills, search, capFilter, statusFilter, sortBy])

  const totalPages  = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages - 1)
  const paged       = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)

  function resetPage(fn: () => void) { fn(); setPage(0) }

  return (
    <div className="space-y-3">
      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Search */}
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            className="pl-8 h-8 text-xs"
            placeholder={t('marketplace.installed_tab.search_placeholder')}
            value={search}
            onChange={(e) => resetPage(() => setSearch(e.target.value))}
          />
        </div>

        {/* Capability type filter */}
        <Select value={capFilter} onValueChange={(v) => resetPage(() => setCapFilter(v))}>
          <SelectTrigger className="h-8 text-xs w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('marketplace.installed_tab.filter_cap_all')}</SelectItem>
            {capTypes.map((ct) => (
              <SelectItem key={ct} value={ct}>
                {t(`marketplace.capability_type.${ct}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Status filter */}
        <Select value={statusFilter} onValueChange={(v) => resetPage(() => setStatusFilter(v))}>
          <SelectTrigger className="h-8 text-xs w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('marketplace.installed_tab.filter_status_all')}</SelectItem>
            <SelectItem value="active">{t('marketplace.installed_section.active')}</SelectItem>
            <SelectItem value="disabled">{t('marketplace.installed_section.disabled')}</SelectItem>
          </SelectContent>
        </Select>

        {/* Sort */}
        <Select value={sortBy} onValueChange={(v) => resetPage(() => setSortBy(v as typeof sortBy))}>
          <SelectTrigger className="h-8 text-xs w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="installed_at">{t('marketplace.installed_tab.sort_recent')}</SelectItem>
            <SelectItem value="name">{t('marketplace.installed_tab.sort_name')}</SelectItem>
            <SelectItem value="version">{t('marketplace.installed_tab.sort_version')}</SelectItem>
          </SelectContent>
        </Select>

        {/* Count */}
        {filtered.length > 0 && (
          <span className="text-xs text-muted-foreground ml-auto tabular-nums">
            {t('marketplace.installed_tab.count', {
              from:  String(currentPage * PAGE_SIZE + 1),
              to:    String(Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)),
              total: String(filtered.length),
            })}
          </span>
        )}
      </div>

      {/* ── List ── */}
      {paged.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <Package className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              {skills.length === 0
                ? t('marketplace.installed_section.empty')
                : t('marketplace.installed_tab.empty_filtered')}
            </p>
            {skills.length === 0 && isAdmin && (
              <p className="text-xs text-muted-foreground">
                {t('marketplace.installed_section.empty_hint')}
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0 divide-y divide-surface-border">
            {paged.map((skill) => {
              const versionDisplay = formatVersion(skill)
              return (
                <div key={skill.id} className="flex items-start justify-between gap-4 px-4 py-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    {/* Name + badges */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-foreground">{skill.name}</span>
                      {/* Capability type */}
                      {skill.capability_type && (
                        <span
                          className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded border font-mono ${
                            CAP_CLASS[skill.capability_type] ?? 'bg-muted text-muted-foreground border-border'
                          }`}
                        >
                          {t(`marketplace.capability_type.${skill.capability_type}`)}
                        </span>
                      )}
                      {/* Status */}
                      {skill.enabled
                        ? <Badge variant="completed">{t('marketplace.installed_section.active')}</Badge>
                        : <Badge variant="pending">{t('marketplace.installed_section.disabled')}</Badge>
                      }
                      {skill.scan_status === 'failed' && (
                        <Badge variant="failed">{t('marketplace.installed_section.scan_failed')}</Badge>
                      )}
                      {skill.pending_update != null && (
                        <Badge className="text-xs py-0 bg-amber-500/20 text-amber-400 border-amber-700">
                          {t('marketplace.installed_section.update_badge')}
                        </Badge>
                      )}
                    </div>

                    {/* Meta row */}
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground flex-wrap">
                      {skill.pack_id && (
                        <span className="font-mono text-[11px]">{skill.pack_id}</span>
                      )}
                      {skill.author && (
                        <><span className="opacity-40">·</span><span>{skill.author}</span></>
                      )}
                      <span className="opacity-40">·</span>
                      <span className="flex items-center gap-1">
                        <SourceIcon type={skill.source_type} />
                        {skill.source_type}
                      </span>
                      {versionDisplay && (
                        <><span className="opacity-40">·</span><span className="font-mono text-[11px]">{versionDisplay}</span></>
                      )}
                      {skill.installed_at && (
                        <><span className="opacity-40">·</span>
                        <span>{new Date(skill.installed_at).toLocaleDateString(locale)}</span></>
                      )}
                    </div>

                    {/* Tags (clickable → filter) */}
                    {skill.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-0.5">
                        {skill.tags.map((tag) => (
                          <button
                            key={tag}
                            onClick={() => resetPage(() => setSearch(tag))}
                            className="text-[10px] px-1.5 py-0.5 rounded border border-border bg-muted text-muted-foreground hover:border-primary/40 hover:text-foreground transition-colors font-mono"
                          >
                            #{tag}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Admin actions */}
                  {isAdmin && (
                    <div className="shrink-0 pt-0.5">
                      <SkillActionsClient
                        skillId={skill.id}
                        name={skill.name}
                        config={skill.config}
                        enabled={skill.enabled}
                        scanStatus={skill.scan_status}
                        approvedBy={skill.approved_by}
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </CardContent>
        </Card>
      )}

      {/* ── Pagination ── */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <Button
            size="sm" variant="outline" className="h-7 w-7 p-0"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">
            {currentPage + 1} / {totalPages}
          </span>
          <Button
            size="sm" variant="outline" className="h-7 w-7 p-0"
            disabled={currentPage >= totalPages - 1}
            onClick={() => setPage(currentPage + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  )
}
