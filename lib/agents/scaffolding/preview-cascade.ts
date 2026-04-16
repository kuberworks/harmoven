// lib/agents/scaffolding/preview-cascade.ts
// Preview cascade — Amendment 73, Section 25.3.
//
// Resolves the best available preview for a running scaffolded app:
//   Mode 1 — subdomain (requires wildcard DNS + Traefik)
//   Mode 2 — subpath   (reverse-proxy rewrite; LLM repair fallback)
//   Mode 3 — screenshots (universal fallback; always produced)
//
// Config: app_scaffolding.preview in orchestrator.yaml
// Env:    APP_SCAFFOLDING_PREVIEW_MODE, APP_SCAFFOLDING_PREVIEW_WILDCARD_DOMAIN,
//         APP_SCAFFOLDING_PREVIEW_BASE_URL, APP_SCAFFOLDING_SMOKE_TEST_TIMEOUT_S

import fs   from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import type { ILLMClient } from '@/lib/llm/interface'
import { repairForSubpath } from './repair.agent'

// ─── Types ────────────────────────────────────────────────────────────────────

export type PreviewType = 'subdomain' | 'subpath' | 'subpath_repaired' | 'screenshots'

export interface PreviewResult {
  type:        PreviewType
  url:         string | null    // live navigable URL (null for screenshots-only)
  screenshots: string[]         // absolute paths to PNG files
}

export interface RouteCheck {
  path:        string
  status:      number
  ok:          boolean
  description: string           // plain language for guided UI
}

export interface PreviewConfig {
  mode:            'auto' | 'subdomain' | 'subpath' | 'screenshots'
  wildcard_domain: string       // e.g. "preview.harmoven.mycompany.com"
  base_url:        string       // e.g. "https://harmoven.mycompany.com"
}

// ─── Config loader ────────────────────────────────────────────────────────────

interface OrchestratorPreview {
  app_scaffolding?: {
    preview?: Partial<PreviewConfig>
  }
}

/** Load preview config from orchestrator.yaml + env overrides. */
export function loadPreviewConfig(yamlPath?: string): PreviewConfig {
  let fromYaml: Partial<PreviewConfig> = {}
  try {
    const raw = fs.readFileSync(
      yamlPath ?? path.resolve(process.cwd(), 'orchestrator.yaml'), 'utf8',
    )
    const parsed = yaml.load(raw) as OrchestratorPreview
    fromYaml = parsed?.app_scaffolding?.preview ?? {}
  } catch {
    // absent or unparseable — use defaults
  }

  return {
    mode:            (process.env.APP_SCAFFOLDING_PREVIEW_MODE as PreviewConfig['mode'])
                     ?? fromYaml.mode
                     ?? 'auto',
    wildcard_domain: process.env.APP_SCAFFOLDING_PREVIEW_WILDCARD_DOMAIN
                     ?? fromYaml.wildcard_domain
                     ?? '',
    base_url:        process.env.APP_SCAFFOLDING_PREVIEW_BASE_URL
                     ?? fromYaml.base_url
                     // auto-detect from AUTH_URL (common Next.js convention)
                     ?? (process.env.AUTH_URL ? new URL(process.env.AUTH_URL).origin : '')
                     ?? '',
  }
}

// ─── Timeout ─────────────────────────────────────────────────────────────────

const SMOKE_TIMEOUT_MS = parseInt(
  process.env.APP_SCAFFOLDING_SMOKE_TEST_TIMEOUT_S ?? '30', 10,
) * 1000

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

/** Probe a URL with a timeout. Returns { status, ok }. */
export async function smokeTestUrl(
  url: string,
  timeoutMs = SMOKE_TIMEOUT_MS,
): Promise<{ status: number; ok: boolean }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method:  'GET',
      redirect: 'follow',
      signal: controller.signal,
    })
    return { status: res.status, ok: res.status < 400 }
  } catch {
    return { status: 0, ok: false }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Check a set of routes and return RouteCheck results.
 * Routes that don't exist (404 at the path level vs app error) are treated as skipped.
 */
export async function checkRoutes(
  baseUrl: string,
  routes:  string[],
): Promise<RouteCheck[]> {
  const results: RouteCheck[] = []
  for (const routePath of routes) {
    const url = `${baseUrl.replace(/\/$/, '')}${routePath}`
    const { status, ok } = await smokeTestUrl(url, 5_000)
    results.push({
      path: routePath,
      status,
      ok,
      description: ok
        ? `${routePath} loads correctly (HTTP ${status})`
        : status === 0
          ? `${routePath} did not respond (timeout or connection refused)`
          : `${routePath} returned HTTP ${status}`,
    })
  }
  return results
}

// ─── Screenshots ──────────────────────────────────────────────────────────────

/**
 * Capture Puppeteer screenshots for a set of pages.
 * Returns absolute paths to PNG files written in the run's output directory.
 * If Puppeteer is not installed, returns [] (graceful degradation).
 */
export async function captureScreenshots(
  baseUrl:   string,
  routes:    string[] = ['/', '/login', '/dashboard'],
  outputDir: string  = '/tmp/harmoven-previews',
  runId?:    string,
): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let puppeteer: any = null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    puppeteer = require('puppeteer') as typeof puppeteer
  } catch {
    // Puppeteer not installed — screenshots fallback unavailable.
    console.warn('[preview-cascade] puppeteer not installed — screenshots skipped')
    return []
  }

  const dir = runId ? path.join(outputDir, runId) : outputDir
  fs.mkdirSync(dir, { recursive: true })

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  const paths: string[] = []
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })

  for (const routePath of routes) {
    const url = `${baseUrl.replace(/\/$/, '')}${routePath}`
    try {
      const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 10_000 })
      if (!response || response.status() >= 500) continue

      const slug   = routePath.replace(/\//g, '_').replace(/^_/, '') || 'home'
      const filePath = path.join(dir, `${slug}.png`)
      await page.screenshot({ path: filePath, fullPage: true })
      paths.push(filePath)
    } catch {
      // Page load error — skip this route's screenshot
    }
  }

  await browser.close()
  return paths
}

// ─── Traefik helpers ──────────────────────────────────────────────────────────

const TRAEFIK_DIR = process.env.APP_SCAFFOLDING_TRAEFIK_DYNAMIC_DIR ?? '/etc/traefik/dynamic'

/** Write a Traefik dynamic config file for subdomain preview routing. */
export async function registerTraefikRoute(
  runId:          string,
  wildcardDomain: string,
  port:           number,
): Promise<void> {
  const config = `
http:
  routers:
    preview-${runId}:
      rule: "Host(\`${runId}.${wildcardDomain}\`)"
      service: preview-${runId}
      tls: {}
  services:
    preview-${runId}:
      loadBalancer:
        servers:
          - url: "http://host.docker.internal:${port}"
`.trimStart()

  const filePath = path.join(TRAEFIK_DIR, `preview-${runId}.yml`)
  fs.mkdirSync(TRAEFIK_DIR, { recursive: true })
  fs.writeFileSync(filePath, config, 'utf8')
  // Wait briefly for Traefik to pick up the dynamic config
  await new Promise(r => setTimeout(r, 1000))
}

/** Remove the Traefik dynamic config file for a run (on gate close). */
export function removeTraefikRoute(runId: string): void {
  const filePath = path.join(TRAEFIK_DIR, `preview-${runId}.yml`)
  try { fs.unlinkSync(filePath) } catch { /* already removed */ }
}

// ─── Subpath proxy helpers ────────────────────────────────────────────────────

// Subpath proxy: Next.js middleware rewrites /preview/{runId}/* → localhost:{port}/*
// In Docker, this is handled by a reverse-proxy rule in the Harmoven Next.js app's middleware.
// We signal the proxy by writing a record; actual proxying is done in middleware.ts.

const SUBPATH_PROXY_DIR = process.env.APP_SCAFFOLDING_PROXY_DIR ?? '/tmp/harmoven-proxies'

/** Register a subpath proxy entry for a run (written to disk; middleware reads it). */
export async function registerSubpathProxy(runId: string, port: number): Promise<void> {
  fs.mkdirSync(SUBPATH_PROXY_DIR, { recursive: true })
  fs.writeFileSync(
    path.join(SUBPATH_PROXY_DIR, `${runId}.json`),
    JSON.stringify({ run_id: runId, port, registered_at: new Date().toISOString() }),
    'utf8',
  )
  // Brief wait for the proxy to become active
  await new Promise(r => setTimeout(r, 500))
}

/** Remove the subpath proxy entry for a run. */
export function removeSubpathProxy(runId: string): void {
  const filePath = path.join(SUBPATH_PROXY_DIR, `${runId}.json`)
  try { fs.unlinkSync(filePath) } catch { /* already removed */ }
}

function modeIncludes(mode: PreviewConfig['mode'], target: string): boolean {
  return mode === 'auto' || mode === target
}

// ─── Preview cascade ──────────────────────────────────────────────────────────

/**
 * Resolve the best available preview for a running scaffolded app.
 * Implements the Am.73 cascade: subdomain → subpath → screenshots.
 */
export async function resolvePreview(
  config:   PreviewConfig,
  runId:    string,
  port:     number,
  worktree: string,
  llm:      ILLMClient,
  signal?:  AbortSignal,
): Promise<PreviewResult> {
  const localBase = `http://localhost:${port}`
  const routes    = ['/', '/login', '/dashboard']

  // Mode 1 — Subdomain (best UX, no app modification required)
  if (config.wildcard_domain && modeIncludes(config.mode, 'subdomain')) {
    try {
      await registerTraefikRoute(runId, config.wildcard_domain, port)
      const url = `https://${runId}.${config.wildcard_domain}/`
      const { ok } = await smokeTestUrl(url)
      if (ok) {
        const screenshots = await captureScreenshots(url, routes, undefined, runId)
        return { type: 'subdomain', url, screenshots }
      }
    } catch (err) {
      console.warn('[preview-cascade] subdomain mode failed:', err)
    }
    removeTraefikRoute(runId)
  }

  // Mode 2 — Subpath (no DNS required; may need app config repair)
  if (config.base_url && modeIncludes(config.mode, 'subpath')) {
    const subpath = `/preview/${runId}/`
    const url     = `${config.base_url.replace(/\/$/, '')}${subpath}`

    try {
      await registerSubpathProxy(runId, port)

      // Attempt 1 — try as-is
      const { ok: ok1 } = await smokeTestUrl(url)
      if (ok1) {
        const screenshots = await captureScreenshots(url, routes, undefined, runId)
        return { type: 'subpath', url, screenshots }
      }

      // Attempt 2 — RepairAgent patches the app, rebuild, retry
      if (!signal?.aborted) {
        await repairForSubpath(worktree, subpath, llm, signal)
        const { ok: ok2 } = await smokeTestUrl(url)
        if (ok2) {
          const screenshots = await captureScreenshots(url, routes, undefined, runId)
          return { type: 'subpath_repaired', url, screenshots }
        }
      }
    } catch (err) {
      console.warn('[preview-cascade] subpath mode failed:', err)
    }

    removeSubpathProxy(runId)
  }

  // Mode 3 — Screenshots only (universal fallback; always produced)
  const screenshots = await captureScreenshots(localBase, routes, undefined, runId)
  return { type: 'screenshots', url: null, screenshots }
}
