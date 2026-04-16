'use client'
// components/shared/PageBreadcrumb.tsx
// Drop this in any Server or Client page to register breadcrumb items in the topbar.
// Usage: <PageBreadcrumb items={[{ label: 'Projects', href: '/projects' }, { label: project.name }]} />
// Renders nothing — side-effect only.

import { useEffect } from 'react'
import { useBreadcrumbContext, type BreadcrumbItem } from './BreadcrumbContext'

interface Props {
  items: BreadcrumbItem[]
}

export function PageBreadcrumb({ items }: Props) {
  const { setItems } = useBreadcrumbContext()

  // Serialise items as the dep value to avoid infinite loops when the
  // caller passes a new array literal on every render.
  const serialised = JSON.stringify(items)

  useEffect(() => {
    setItems(items)
    return () => setItems([])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialised])

  return null
}
