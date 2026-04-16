// app/page.tsx
// Root redirect — send to /dashboard if authenticated, /login otherwise.
// Server Component: reads session server-side to avoid redirect flicker.

import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'

export default async function RootPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (session?.user) {
    redirect('/dashboard')
  }
  redirect('/login')
}
