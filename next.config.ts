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
              "style-src 'self' 'unsafe-inline'",  // Tailwind inline styles — unsafe-inline
              // retained because Tailwind v3 emits inline styles; removing it requires a
              // runtime nonce strategy (future enhancement, post-T3.9).
              "img-src 'self' data: blob:",
              "font-src 'self'",
              // connect-src: SSE streams use EventSource to same-origin paths (/api/…).
              // ws:/wss: are only needed in dev for Next.js HMR WebSocket.
              // Wildcard wss:/ws: is removed from production to prevent exfiltration via
              // arbitrary WebSocket endpoints (I-03).
              process.env.NODE_ENV === 'production'
                ? "connect-src 'self'"
                : "connect-src 'self' ws: wss:",  // HMR WebSocket in dev
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

  // Webpack externals — modules that are conditionally required at runtime but
  // are not installed in the web/Docker environment. Marking them external
  // prevents webpack from trying to bundle them and emitting spurious warnings.
  //   • electron  — only used in DEPLOYMENT_MODE=electron (lib/config-git/paths.ts)
  //   • puppeteer — optional screenshots fallback (lib/agents/scaffolding/preview-cascade.ts)
  //   • pyodide   — spawned via worker_threads in python-executor.ts; its internal
  //                 require() calls use dynamic expressions that webpack cannot
  //                 statically analyse, generating "Critical dependency" warnings.
  webpack(config) {
    config.externals = [
      ...(Array.isArray(config.externals) ? config.externals : config.externals ? [config.externals] : []),
      'electron',
      'puppeteer',
      'pyodide',
    ]
    return config
  },

  // File tracing — ensure the Pyodide worker CJS is included in standalone builds.
  // Next.js output: 'standalone' traces only imported files; the worker is spawned
  // at runtime via worker_threads and is not statically imported, so it must be
  // listed here explicitly.
  outputFileTracingIncludes: {
    '/api/**': ['./lib/agents/python-executor.worker.cjs'],
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
