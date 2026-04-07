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
