// app/api/auth/[...all]/route.ts
// Better Auth HTTP handler — catches all /api/auth/* requests.
// toNextJsHandler() maps GET/POST to the appropriate auth endpoint.

import { auth } from '@/lib/auth'
import { toNextJsHandler } from 'better-auth/next-js'

export const { GET, POST } = toNextJsHandler(auth)
