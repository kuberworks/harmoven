import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',

  // HTTP security headers — applied on every response
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'X-Permitted-Cross-Domain-Policies',
            value: 'none',
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
          // Strict-Transport-Security — only in production (HTTPS required)
          ...(process.env.NODE_ENV === 'production'
            ? [
                {
                  key: 'Strict-Transport-Security',
                  value: 'max-age=63072000; includeSubDomains; preload',
                },
              ]
            : []),
          // Content-Security-Policy
          // Production: strict — no unsafe-eval/unsafe-inline in script-src.
          // Development: relaxed for Next.js HMR (unsafe-eval required).
          // T3.9 (Step 25) will add nonce-based CSP to remove unsafe-inline from style-src.
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              process.env.NODE_ENV === 'production'
                ? "script-src 'self'" // tightened further with nonces in T3.9
                : "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src 'self'",
              "connect-src 'self'",
              "frame-ancestors 'none'",
            ].join('; '),
          },
        ],
      },
    ]
  },

  // Experimental features
  experimental: {
    serverActions: {
      // Derive allowed origins from AUTH_URL so that production deployments with a
      // custom domain don't silently block Server Actions (Next.js CSRF protection).
      allowedOrigins: [
        (process.env.AUTH_URL ?? 'http://localhost:3000')
          .replace(/^https?:\/\//, '')
          .replace(/\/$/, ''),
        'localhost:3000',  // always allow localhost for dev
      ],
    },
  },
}

export default nextConfig
