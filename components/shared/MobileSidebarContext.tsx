'use client'

// components/shared/MobileSidebarContext.tsx
// Provides mobile sidebar open/close state shared between Topbar (trigger)
// and Sidebar (drawer). Both are client components in the authenticated shell.

import { createContext, useContext, useState, type ReactNode } from 'react'

interface MobileSidebarContextType {
  isOpen: boolean
  open: () => void
  close: () => void
}

const MobileSidebarContext = createContext<MobileSidebarContextType>({
  isOpen: false,
  open: () => {},
  close: () => {},
})

export function MobileSidebarProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <MobileSidebarContext.Provider
      value={{ isOpen, open: () => setIsOpen(true), close: () => setIsOpen(false) }}
    >
      {children}
    </MobileSidebarContext.Provider>
  )
}

export function useMobileSidebar() {
  return useContext(MobileSidebarContext)
}
