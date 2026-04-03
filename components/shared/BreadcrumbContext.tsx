'use client'
// components/shared/BreadcrumbContext.tsx
// Context for topbar breadcrumbs — pages register their nav path via PageBreadcrumb.
// UX.md §1 — breadcrumb slot fix (CRITICAL).

import { createContext, useContext, useState, type ReactNode } from 'react'

export interface BreadcrumbItem {
  label: string
  href?:  string
}

interface BreadcrumbContextType {
  items: BreadcrumbItem[]
  setItems: (items: BreadcrumbItem[]) => void
}

const BreadcrumbContext = createContext<BreadcrumbContextType>({
  items:    [],
  setItems: () => {},
})

export function BreadcrumbProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<BreadcrumbItem[]>([])
  return (
    <BreadcrumbContext.Provider value={{ items, setItems }}>
      {children}
    </BreadcrumbContext.Provider>
  )
}

export function useBreadcrumbContext() {
  return useContext(BreadcrumbContext)
}
