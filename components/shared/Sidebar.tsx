'use client'

// components/shared/Sidebar.tsx
// Left sidebar nav — 260px fixed / collapsible to 48px icon rail.
// Spec: UX.md §2.1, DESIGN_SYSTEM.md §1.4.
// RBAC: Analytics + Admin links hidden when permissions absent.

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard, Play, FolderOpen, ShoppingBag, Settings,
  BarChart2, Shield, Users, ChevronLeft, ChevronRight,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'

interface NavItem {
  label: string
  href: string
  icon: typeof LayoutDashboard
  /** Permission required to show the link (undefined = always visible) */
  requiresRole?: 'admin' | 'instance_admin'
}

const PRIMARY_NAV: NavItem[] = [
  { label: 'Dashboard',   href: '/dashboard',   icon: LayoutDashboard },
  { label: 'Runs',        href: '/runs',         icon: Play },
  { label: 'Projects',    href: '/projects',     icon: FolderOpen },
  { label: 'Marketplace', href: '/marketplace',  icon: ShoppingBag },
]

const SECONDARY_NAV: NavItem[] = [
  { label: 'Settings',  href: '/settings',  icon: Settings },
  { label: 'Members',   href: '/members',   icon: Users,   requiresRole: 'admin' },
  { label: 'Analytics', href: '/analytics', icon: BarChart2, requiresRole: 'admin' },
  { label: 'Admin',     href: '/admin',     icon: Shield,  requiresRole: 'instance_admin' },
]

interface SidebarProps {
  /** Simplified role string from session */
  instanceRole?: string
}

export function Sidebar({ instanceRole }: SidebarProps) {
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useState(false)

  function isVisible(item: NavItem) {
    if (!item.requiresRole) return true
    if (item.requiresRole === 'admin') return instanceRole === 'admin' || instanceRole === 'instance_admin'
    if (item.requiresRole === 'instance_admin') return instanceRole === 'instance_admin'
    return false
  }

  function isActive(href: string) {
    return pathname === href || pathname.startsWith(href + '/')
  }

  return (
    <aside
      className={cn(
        'relative flex flex-col border-r border-border bg-surface-raised transition-all duration-150 ease-out',
        collapsed ? 'w-12' : 'w-[260px]'
      )}
    >
      {/* Logo */}
      <div className={cn('flex h-14 items-center border-b border-border px-3', collapsed && 'justify-center')}>
        {!collapsed && (
          <span className="text-base font-bold tracking-tight select-none">
            Harmo<span className="text-[var(--accent-amber-9)]">ven</span>
          </span>
        )}
        {collapsed && (
          <span className="text-base font-bold text-[var(--accent-amber-9)] select-none">H</span>
        )}
      </div>

      {/* Primary nav */}
      <nav className="flex flex-col gap-0.5 p-2 flex-1" aria-label="Main navigation">
        {PRIMARY_NAV.map(item => (
          <NavLink key={item.href} item={item} collapsed={collapsed} active={isActive(item.href)} />
        ))}

        <div className="my-1 h-px bg-border" />

        {SECONDARY_NAV.filter(isVisible).map(item => (
          <NavLink key={item.href} item={item} collapsed={collapsed} active={isActive(item.href)} />
        ))}
      </nav>

      {/* Collapse toggle */}
      <button
        onClick={() => setCollapsed(c => !c)}
        className="absolute -right-3 top-16 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-surface-raised shadow-sm hover:bg-surface-hover transition-colors duration-150"
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronLeft className="h-3 w-3" />}
      </button>
    </aside>
  )
}

function NavLink({
  item, collapsed, active,
}: { item: NavItem; collapsed: boolean; active: boolean }) {
  const Icon = item.icon
  return (
    <Link
      href={item.href}
      title={collapsed ? item.label : undefined}
      className={cn(
        'flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm transition-colors duration-150',
        active
          ? 'bg-[var(--accent-amber-3)] text-[var(--accent-amber-9)] font-medium'
          : 'text-muted-foreground hover:bg-surface-hover hover:text-foreground',
        collapsed && 'justify-center px-2'
      )}
      aria-current={active ? 'page' : undefined}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {!collapsed && <span>{item.label}</span>}
    </Link>
  )
}
