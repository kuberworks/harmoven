import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',

  // HTTP security headers — applied on every response.
  // Spec: Amendment 92 (92.10) — complete header set.
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          // ── Clickjacking ────────────────────────────────────────────────────
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          // ── MIME sniffing ───────────────────────────────────────────────────
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          // ── Cross-domain policy (Flash/Silverlight) ──────────────────────────
          {
            key: 'X-Permitted-Cross-Domain-Policies',
            value: 'none',
          },
          // ── Referrer ────────────────────────────────────────────────────────
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          // ── Permissions ─────────────────────────────────────────────────────
          {
            key: 'Permissions-Policy',
            value: [
              'camera=()',
              'microphone=()',
              'geolocation=()',
              'interest-cohort=()',  // FLoC opt-out
            ].join(', '),
          },
          // ── Cross-Origin isolation ──────────────────────────────────────────
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin',
          },
          {
            key: 'Cross-Origin-Resource-Policy',
            value: 'same-origin',
          },
          {
            key: 'Cross-Origin-Embedder-Policy',
            value: 'require-corp',
          },
          // ── HSTS — only meaningful in production (requires HTTPS) ────────────
          ...(process.env.NODE_ENV === 'production'
            ? [
                {
                  key: 'Strict-Transport-Security',
                  value: 'max-age=63072000; includeSubDomains; preload',
                },
              ]
            : []),
          // ── Content-Security-Policy ─────────────────────────────────────────
          // frame-src 'none' requires gate preview to use subpath mode (Am.73).
          // connect-src: 'self' + wss:/ws: for SSE streams.
          // style-src: unsafe-inline retained for Tailwind CSS (no inline-removal
          //   without a runtime nonce strategy — future enhancement post-T3.9).
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              process.env.NODE_ENV === 'production'
                ? "script-src 'self'"
                : "script-src 'self' 'unsafe-eval' 'unsafe-inline'",  // HMR in dev
              "style-src 'self' 'unsafe-inline'",  // Tailwind inline styles
              "img-src 'self' data: blob:",
              "font-src 'self'",
              "connect-src 'self' wss: ws:",    // SSE + WebSocket
              "frame-src 'none'",               // no iframes
              "frame-ancestors 'none'",         // no embedding Harmoven
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
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
