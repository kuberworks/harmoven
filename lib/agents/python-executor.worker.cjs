// lib/agents/python-executor.worker.cjs
// Worker thread that loads Pyodide and executes Python code in a sandboxed environment.
// Must be a .cjs file so that require('pyodide') resolves correctly regardless of
// the parent project's module type.
//
// Security model:
//   - Replaces __builtins__.__import__ with a safe version that blocks dangerous modules.
//   - Captures stdout/stderr via Pyodide's setStdout/setStderr hooks.
//   - Runs inside a worker_threads Worker so the parent can call worker.terminate()
//     on timeout — killing the WASM execution and the entire thread.
//   - resourceLimits.maxOldGenerationSizeMb (set by the parent) caps heap usage.
//
// This file is intentionally .cjs so it can use require() even when the parent project
// uses ESM ("type": "module"). The parent imports it via its file path, not via import.

'use strict'

const { workerData, parentPort } = require('worker_threads')

// Security model: Pyodide runs CPython compiled to WebAssembly. All system
// calls (network, filesystem, process) go through Emscripten's WASM bridge
// which provides a sandboxed emulation — no real host access is possible.
// A Python-level import firewall is therefore unnecessary and actively harmful:
// it breaks every major data-science package (pandas, matplotlib, scipy, sklearn)
// because they all transitively import stdlib modules like os, urllib, subprocess.
// The real protection is: (a) WASM sandbox, (b) worker_threads isolation with
// terminate() on timeout, (c) heap cap via resourceLimits, (d) micropip blocked
// at the package-install level so user code can't install new packages at runtime.

;(async () => {
  let stdout = ''
  let stderr = ''

  try {
    // loadPyodide is resolved at the path passed by the parent so that this CJS
    // worker finds the correct package even when running from an unusual cwd.
    const { loadPyodide } = require(workerData.pyodidePath)
    const py = await loadPyodide()

    // Discard Pyodide initialisation messages (loadPackage, micropip status lines
    // such as "Loading micropip" / "Loaded micropip") so they do not pollute the
    // user-visible stdout that appears in the run detail UI.
    py.setStdout({ batched: () => {} })
    py.setStderr({ batched: () => {} })

    // ── Headless environment preamble ─────────────────────────────────────────
    // Force non-interactive (Agg) backend for matplotlib BEFORE any import runs.
    //
    // Root cause: Pyodide's Python is compiled with browser support; when matplotlib
    // is imported it auto-detects the Pyodide `js` module and loads its browser
    // backend, which does `from js import document`. In a Node.js worker_threads
    // context there is no DOM, so `document` does not exist in the `js` module and
    // the import fails with:
    //   ImportError: cannot import name 'document' from 'js' (unknown location)
    //
    // Setting MPLBACKEND=Agg (the non-interactive rasterizer) before any import
    // prevents the backend probe entirely. NOT using setdefault here — we must
    // override unconditionally because user code hasn't run yet at this point.
    py.runPython('import os as _os; _os.environ["MPLBACKEND"] = "Agg"; del _os')

    // plotly: force the static JSON renderer so plotly.io doesn't try to open a
    // browser or call js.document.getElementById (which doesn't exist in a Node.js
    // worker_threads context even though the Pyodide `js` module is present).
    // Must be set before `import plotly` runs — same root cause as matplotlib.
    // We test for plotly availability first so the preamble is a no-op when plotly
    // is not installed (avoids a spurious ModuleNotFoundError in the preamble).
    py.runPython(`
import sys as _sys
if 'plotly' in _sys.modules or True:
    try:
        import plotly.io as _pio
        _pio.renderers.default = 'json'
        del _pio
    except ModuleNotFoundError:
        pass
del _sys
`)

    // ── Package installation ──────────────────────────────────────────────────
    // Package download goes through Node.js fetch (Emscripten bridge), NOT Python
    // sockets, so this is safe even though 'socket' is blocked for user code.
    //
    // Two modes:
    //   explicit  — workerData.packages is a non-empty array → install exactly those.
    //               Use when the import name differs from the PyPI package name
    //               (e.g. `import cv2` needs `packages: ['opencv-python']`).
    //   auto      — workerData.packages is empty/absent → parse the code's import
    //               statements with Python's `ast` module and install any name that
    //               is not stdlib and not already loaded. Best-effort: install errors
    //               are swallowed so user code gets a normal ImportError if a package
    //               is unavailable rather than a confusing pre-run failure.
    await py.loadPackage('micropip')

    if (Array.isArray(workerData.packages) && workerData.packages.length > 0) {
      // Explicit mode: install exactly the listed packages, then pre-import them
      // so all transitive deps are in sys.modules before user code runs.
      const pkgJson = JSON.stringify(workerData.packages)
      await py.runPythonAsync(`
import micropip as _mp
await _mp.install(${pkgJson})
for _pkg in ${pkgJson}:
    _base = _pkg.split('==')[0].split('>=')[0].split('[')[0].replace('-','_')
    try:
        __import__(_base)
    except Exception:
        pass
del _mp, _pkg, _base
`)
    } else {
      // Auto-detect mode: parse imports from the AST, install third-party packages,
      // then pre-import so all transitive deps land in sys.modules before user code runs.
      const autoInstallCode = `
async def _auto_install():
    import sys, ast, micropip as _mp
    _code = ${JSON.stringify(workerData.code)}
    _names = set()
    for _n in ast.walk(ast.parse(_code)):
        if isinstance(_n, ast.Import):
            for _a in _n.names:
                _names.add(_a.name.split('.')[0])
        elif isinstance(_n, ast.ImportFrom) and _n.module and _n.level == 0:
            _names.add(_n.module.split('.')[0])
    _stdlib = getattr(sys, 'stdlib_module_names', frozenset())
    _third_party = [p for p in _names if p not in _stdlib and p not in sys.modules]
    if _third_party:
        try:
            await _mp.install(_third_party)
        except Exception:
            pass  # user code will get a normal ImportError if a package is unavailable
    # Pre-import all detected packages so their sub-modules are fully initialised.
    for _name in _names:
        if _name not in _stdlib:
            try:
                __import__(_name)
            except Exception:
                pass
await _auto_install()
del _auto_install
`
      await py.runPythonAsync(autoInstallCode)
    }

    // Execute user-supplied Python code.
    // Switch stdout/stderr to capture mode immediately before running user code
    // so only user-emitted output appears in the run detail UI.
    py.setStdout({ batched: (s) => { stdout += s + '\n' } })
    py.setStderr({ batched: (s) => { stderr += s + '\n' } })
    py.runPython(workerData.code)

    // ─── Collect generated files ──────────────────────────────────────────────
    // Scan /home/pyodide after execution. Transfer raw ArrayBuffers (zero-copy).
    // Files outside ALLOWED_MIME or over MAX_FILE_BYTES are silently skipped.
    // This must run AFTER user code so we only collect intentionally generated files.

    const ALLOWED_MIME = {
      // Office / data formats
      'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'xls':  'application/vnd.ms-excel',
      'csv':  'text/csv',
      'json': 'application/json',
      'pdf':  'application/pdf',
      // Document / markup
      'txt':  'text/plain',
      'md':   'text/markdown',
      'html': 'text/html',    // kept for preview potential — download-only on client
      'xml':  'text/xml',
      'css':  'text/css',
      'sql':  'text/plain',
      // Images
      'png':  'image/png',
      'svg':  'image/svg+xml',
      // Source code — project scaffold support (JVM, JS/TS, Python, Go, Rust, …)
      'java':       'text/plain',
      'kt':         'text/plain',
      'scala':      'text/plain',
      'groovy':     'text/plain',
      'py':         'text/plain',
      'js':         'text/plain',
      'ts':         'text/plain',
      'jsx':        'text/plain',
      'tsx':        'text/plain',
      'go':         'text/plain',
      'rs':         'text/plain',
      'c':          'text/plain',
      'cpp':        'text/plain',
      'h':          'text/plain',
      'hpp':        'text/plain',
      'cs':         'text/plain',
      'rb':         'text/plain',
      'php':        'text/plain',
      'swift':      'text/plain',
      // Build / config files
      'properties': 'text/plain',
      'yml':        'text/yaml',
      'yaml':       'text/yaml',
      'toml':       'text/plain',
      'gradle':     'text/plain',
      'ini':        'text/plain',
      'conf':       'text/plain',
      'sh':         'text/plain',
      'bat':        'text/plain',
      'env':        'text/plain',
    }
    const MAX_FILE_BYTES    = 10 * 1024 * 1024   // 10 MB per file
    const MAX_TOTAL_BYTES   = 50 * 1024 * 1024   // 50 MB total per run

    // Extensions that are Python/platform internals — skipped silently (no user warning).
    const SILENT_SKIP_EXTS = new Set(['pyc', 'pyo', 'pyd', 'so', 'dylib', 'dll', 'whl'])

    // relDir: path relative to /home/pyodide root (empty at root level).
    // _shared: shared mutable state for totalBytes accumulation + skipped list across recursion.
    function collectFiles(py, dir, relDir, _shared) {
      relDir  = relDir  || ''
      _shared = _shared || { totalBytes: 0, skipped: [] }
      const result = []
      try {
        const entries = py.FS.readdir(dir)
        for (const entry of entries) {
          // Skip dotfiles and Python cache dirs (__pycache__, __init__ etc.)
          if (entry.startsWith('.') || entry.startsWith('__')) continue
          const fullPath = dir + '/' + entry
          const relPath  = relDir ? relDir + '/' + entry : entry
          try {
            const stat = py.FS.stat(fullPath)
            if (py.FS.isDir(stat.mode)) {
              result.push(...collectFiles(py, fullPath, relPath, _shared))
              continue
            }
            // Sanitise relative path — preserve forward slashes for subdirectory structure.
            // Block path traversal (..) and absolute paths.
            const safePath = relPath
              .replace(/\.\./g, '_')          // no parent traversal
              .replace(/^[/\\]+/, '')         // no leading slash
              .replace(/[^a-zA-Z0-9._\-/]/g, '_')  // safe chars + forward slash
              .slice(0, 500)
            const ext = safePath.split('.').pop()?.toLowerCase() ?? ''
            // Internal bytecode / native extensions — skip silently
            if (SILENT_SKIP_EXTS.has(ext)) continue
            // Files with no recognisable extension (e.g. Pyodide FS temporaries) — skip silently
            if (!ext || safePath === ext) continue
            const mime = ALLOWED_MIME[ext]
            if (!mime) {
              _shared.skipped.push({ name: safePath, reason: 'unknown_ext' })
              continue
            }
            if (stat.size > MAX_FILE_BYTES) {
              _shared.skipped.push({ name: safePath, reason: 'too_large' })
              continue
            }
            if (_shared.totalBytes + stat.size > MAX_TOTAL_BYTES) {
              _shared.skipped.push({ name: safePath, reason: 'total_exceeded' })
              break
            }
            // Read as Uint8Array, then move underlying ArrayBuffer (zero-copy via transferList)
            const u8 = py.FS.readFile(fullPath)          // returns Uint8Array
            _shared.totalBytes += u8.byteLength
            result.push({ name: safePath, mime, sizeBytes: u8.byteLength, buffer: u8.buffer })
          } catch(e) {}
        }
      } catch(e) {}
      return result
    }

    const _collectState  = { totalBytes: 0, skipped: [] }
    const generatedFiles = collectFiles(py, '/home/pyodide', '', _collectState)
    const skippedFiles   = _collectState.skipped
    // Extract transferable ArrayBuffers for zero-copy transfer
    const transferList = generatedFiles.map(f => f.buffer)

    parentPort.postMessage(
      { ok: true, stdout, stderr, error: null, files: generatedFiles, skipped_files: skippedFiles },
      transferList   // transferList = zero-copy ownership transfer to parent
    )
  } catch (e) {
    parentPort.postMessage({
      ok: false,
      stdout,
      stderr,
      error: e instanceof Error ? e.message : String(e),
      files: [],
      skipped_files: [],
    })
  }
})()
