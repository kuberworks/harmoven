// Shared constants for the projects list page.
// Imported by both the Server Component (page.tsx) and the Client Components
// (projects-controls.tsx). Must NOT be a 'use client' module.

export const PAGE_SIZES = [10, 20, 50, 100] as const
export type  PageSize   = typeof PAGE_SIZES[number]
