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

// Modules blocked from user-supplied Python code.
// These are the high-risk modules that grant OS/network/IPC access.
// subprocess is already absent from the Pyodide stdlib but is included for safety.
const BLOCKED_MODULES = [
  'os', 'socket', 'subprocess',
  'urllib', 'urllib3', 'http', 'ftplib', 'smtplib', 'telnetlib', 'imaplib', 'poplib', 'nntplib',
  'multiprocessing', 'ctypes', '_ctypes',
  'mmap', 'signal',
  'pty', 'tty', 'termios', 'fcntl', 'resource', 'grp', 'pwd',
  'msvcrt', 'winreg', 'winsound',
  // Prevent user code from installing additional packages at runtime.
  'micropip', 'pip',
]

const SECURITY_SETUP = `
import builtins as _blt
_BLOCKED = frozenset(${JSON.stringify(BLOCKED_MODULES)})
_real_import = _blt.__import__

# Bind _BLOCKED and _real_import as default args so the function captures them
# at definition time (NOT as global lookups which would fail after del below).
def _safe_import(name, globals=None, locals=None, fromlist=(), level=0,
                 _blocked=_BLOCKED, _orig=_real_import):
    base = name.split('.')[0]
    if base in _blocked:
        raise ImportError("Import of '" + name + "' is blocked in the Harmoven sandbox")
    return _orig(name, globals, locals, fromlist, level)

_blt.__import__ = _safe_import
# Clean up globals so user code can't reach the real import via _real_import etc.
del _blt, _BLOCKED, _real_import, _safe_import
`

;(async () => {
  let stdout = ''
  let stderr = ''

  try {
    // loadPyodide is resolved at the path passed by the parent so that this CJS
    // worker finds the correct package even when running from an unusual cwd.
    const { loadPyodide } = require(workerData.pyodidePath)
    const py = await loadPyodide()

    py.setStdout({ batched: (s) => { stdout += s + '\n' } })
    py.setStderr({ batched: (s) => { stderr += s + '\n' } })

    // ── Package installation (runs BEFORE the import firewall) ────────────────
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
      // Explicit mode: install exactly the listed packages.
      await py.runPythonAsync(
        `import micropip\nawait micropip.install(${JSON.stringify(workerData.packages)})`
      )
    } else {
      // Auto-detect mode: parse imports from the AST and install third-party ones.
      // All variables are local to _auto_install so they don't pollute user globals.
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
    _to_install = [p for p in _names if p not in _stdlib and p not in sys.modules]
    if _to_install:
        try:
            await _mp.install(_to_install)
        except Exception:
            pass  # user code will get a normal ImportError if a package failed
await _auto_install()
del _auto_install
`
      await py.runPythonAsync(autoInstallCode)
    }

    // Install the import firewall before running user code.
    py.runPython(SECURITY_SETUP)

    // Execute user-supplied Python code.
    py.runPython(workerData.code)

    parentPort.postMessage({ ok: true, stdout, stderr, error: null })
  } catch (e) {
    parentPort.postMessage({
      ok: false,
      stdout,
      stderr,
      error: e instanceof Error ? e.message : String(e),
    })
  }
})()
