import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',

  // ESLint is run separately in CI — skipping it during docker build avoids
  // installing devDependencies (eslint plugins) in the builder image layer.
  eslint: {
    ignoreDuringBuilds: true,
  },

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
          // Content-Security-Policy is set per-request in middleware.ts (with nonce)
          // so that Next.js App Router RSC inline scripts can be allowed without
          // unsafe-inline. Static headers here would not support per-request nonces.
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

  // ESM-only packages in the remark/rehype/hast/micromark/unified ecosystem must be
  // transpiled by Next.js/webpack so they can be bundled into browser chunks.
  // Without this, MarkdownContent.tsx (react-markdown + remark-gfm + rehype-sanitize)
  // fails at runtime with "Loading chunk … failed".
  transpilePackages: [
    'react-markdown',
    'remark-gfm',
    'rehype-sanitize',
    'hast-util-sanitize',
    'hast-util-to-jsx-runtime',
    'hast-util-to-html',
    'hast-util-from-parse5',
    'hast-util-from-html',
    'hast-util-is-element',
    'hast-util-has-property',
    'hast-util-whitespace',
    'hast-util-phrasing',
    'hast-util-embedded',
    'hast-util-is-body-ok-link',
    'hast-util-minify-whitespace',
    'hast-util-parse-selector',
    'hast-util-to-text',
    'hast-util-to-mdast',
    'hastscript',
    'mdast-util-from-markdown',
    'mdast-util-gfm',
    'mdast-util-gfm-autolink-literal',
    'mdast-util-gfm-footnote',
    'mdast-util-gfm-strikethrough',
    'mdast-util-gfm-table',
    'mdast-util-gfm-task-list-item',
    'mdast-util-to-hast',
    'mdast-util-to-markdown',
    'mdast-util-to-string',
    'mdast-util-definitions',
    'mdast-util-find-and-replace',
    'mdast-util-phrasing',
    'mdast-util-newline-to-break',
    'mdast-util-mdx-expression',
    'mdast-util-mdx-jsx',
    'mdast-util-mdxjs-esm',
    'micromark',
    'micromark-core-commonmark',
    'micromark-extension-gfm',
    'micromark-extension-gfm-autolink-literal',
    'micromark-extension-gfm-footnote',
    'micromark-extension-gfm-strikethrough',
    'micromark-extension-gfm-table',
    'micromark-extension-gfm-tagfilter',
    'micromark-extension-gfm-task-list-item',
    'micromark-factory-destination',
    'micromark-factory-label',
    'micromark-factory-space',
    'micromark-factory-title',
    'micromark-factory-whitespace',
    'micromark-util-character',
    'micromark-util-chunked',
    'micromark-util-classify-character',
    'micromark-util-combine-extensions',
    'micromark-util-decode-numeric-character-reference',
    'micromark-util-decode-string',
    'micromark-util-encode',
    'micromark-util-html-tag-name',
    'micromark-util-normalize-identifier',
    'micromark-util-resolve-all',
    'micromark-util-sanitize-uri',
    'micromark-util-subtokenize',
    'micromark-util-symbol',
    'micromark-util-types',
    'remark-parse',
    'remark-rehype',
    'remark-stringify',
    'remark-breaks',
    'unified',
    'vfile',
    'vfile-location',
    'vfile-message',
    'bail',
    'trough',
    'is-plain-obj',
    'markdown-table',
  ],
}

export default nextConfig
