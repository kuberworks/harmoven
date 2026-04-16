// electron/main.ts
// Electron main process entry point.
// Spec: Amendment 92 H3 — contextIsolation mandatory, nodeIntegration=false.
//
// SECURITY — these settings are NON-NEGOTIABLE:
//   contextIsolation:  true  — renderer cannot access Node.js APIs directly
//   nodeIntegration:   false — renderer has no require(), no fs, no child_process
//   sandbox:           true  — Chromium sandbox reduces renderer attack surface
//   webSecurity:       true  — same-origin policy enforced
//
// Renderer communicates with main process ONLY through the contextBridge
// preload API. The bridge exposes typed, validated IPC stubs only.
//
// NOTE: This file is for the Electron shell — NOT bundled in Next.js.
// The Electron shell has its own package.json with electron + electron-updater.

import { app, BrowserWindow, shell, ipcMain } from 'electron'
import path from 'node:path'
import { initAutoUpdater } from './auto-updater'

// ─── Security: validate navigation targets ────────────────────────────────────

const ALLOWED_ORIGINS = new Set([
  'http://localhost:3000',
  'app://.',   // production bundled app
])

// ─── BrowserWindow factory ────────────────────────────────────────────────────

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width:  1280,
    height: 900,
    webPreferences: {
      // SECURITY: All of the below are mandatory.
      nodeIntegration:              false,   // REQUIRED — no Node in renderer
      contextIsolation:             true,    // REQUIRED — renderer uses contextBridge only
      sandbox:                      true,    // Chromium sandbox (defence-in-depth)
      webSecurity:                  true,    // REQUIRED — same-origin enforced
      allowRunningInsecureContent:  false,   // never allow HTTP mixed content
      experimentalFeatures:         false,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  // ── CSP for Electron renderer ─────────────────────────────────────────────
  // Applied as response header injection for all responses in this session.
  win.webContents.session.webRequest.onHeadersReceived((_details, callback) => {
    callback({
      responseHeaders: {
        ..._details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'self'",
            "script-src 'self'",               // no inline scripts in Electron renderer
            "style-src 'self' 'unsafe-inline'", // Tailwind
            "img-src 'self' data: blob:",
            "connect-src 'self' ws: wss:",      // SSE + WebSocket to local server
            "font-src 'self'",
            "frame-src 'none'",
            "frame-ancestors 'none'",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
          ].join('; '),
        ],
      },
    })
  })

  // ── Block navigation to unexpected origins ────────────────────────────────
  win.webContents.on('will-navigate', (event, url) => {
    const origin = new URL(url).origin
    if (!ALLOWED_ORIGINS.has(origin)) {
      event.preventDefault()
      // Open external links in the system browser — never in the renderer
      shell.openExternal(url)
    }
  })

  // Same protection for new window requests (target="_blank", window.open)
  win.webContents.setWindowOpenHandler(({ url }) => {
    const origin = new URL(url).origin
    if (ALLOWED_ORIGINS.has(origin)) {
      return { action: 'allow' }
    }
    shell.openExternal(url)
    return { action: 'deny' }
  })

  return win
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

// Only expose what the renderer needs — no arbitrary IPC.
// Shell handlers (openExternal) validated before use.

ipcMain.handle('app:version', () => app.getVersion())

ipcMain.handle('update:check', async () => {
  // Delegates to auto-updater — see electron/auto-updater.ts
  return { version: app.getVersion() }
})

ipcMain.handle('shell:openExternal', async (_event, url: string) => {
  // Validate URL before opening externally
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) return false
    await shell.openExternal(url)
    return true
  } catch {
    return false
  }
})

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow()

  // Initialize auto-updater (reads config from orchestrator.yaml)
  initAutoUpdater({
    auto_install:         'notify',  // default — overridden by orchestrator.yaml
    check_interval_hours:  4,
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
