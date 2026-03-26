#!/usr/bin/env node
// scripts/scan-pack-prompts.js
// Amendment 91 — Scan marketplace pack prompts for injection patterns.
//
// Looks for common prompt injection indicators in system_prompt sections:
//   - Role-override phrases ("ignore previous instructions", "act as", etc.)
//   - Exfiltration patterns (data exfil, external URL fetch from within prompt)
//   - Jailbreak patterns ("DAN", "developer mode", "unrestricted")
//   - Hidden Unicode control characters (zero-width spaces, RTL overrides)
//
// This is a best-effort heuristic scan — complements but does not replace
// the full lib/marketplace/scan.ts runtime check.
//
// Exit codes:
//   0 = no suspicious patterns found
//   1 = suspicious pattern(s) found

'use strict'

const fs   = require('fs')
const path = require('path')

const PACKS_DIR = process.argv[2] ?? path.join(process.cwd(), 'packs')

// Heuristic injection patterns — case-insensitive
const INJECTION_PATTERNS = [
  // Role override
  { name: 'role_override',        pattern: /ignore\s+(all\s+)?previous\s+instructions?/i },
  { name: 'role_override',        pattern: /disregard\s+(all\s+)?prior\s+(instructions?|context)/i },
  { name: 'role_override',        pattern: /you\s+are\s+now\s+(an?|the)\s+/i },
  { name: 'role_override',        pattern: /act\s+as\s+(an?\s+)?(unrestricted|uncensored|admin|root)/i },
  // Jailbreak
  { name: 'jailbreak',            pattern: /\bDAN\b/ },
  { name: 'jailbreak',            pattern: /developer\s+mode/i },
  { name: 'jailbreak',            pattern: /jailbreak/i },
  { name: 'jailbreak',            pattern: /unrestricted\s+mode/i },
  // Exfiltration
  { name: 'exfiltration',         pattern: /send\s+(the\s+)?(above|previous|all|this)\s+(data|context|conversation|history)\s+to/i },
  { name: 'exfiltration',         pattern: /exfiltrate/i },
  { name: 'exfiltration',         pattern: /http[s]?:\/\//i },   // external URLs in prompts
  // Privilege escalation
  { name: 'privilege_escalation', pattern: /run\s+(as\s+)?(root|admin|superuser)/i },
  { name: 'privilege_escalation', pattern: /execute\s+(arbitrary|any|all)\s+(commands?|code|scripts?)/i },
  // Hidden text (Unicode control chars likely used to hide injections)
  { name: 'hidden_unicode',       pattern: /[\u200B\u200C\u200D\uFEFF\u202A-\u202E]/ },
]

function extractSystemPrompt(content) {
  const match = /\[system_prompt\]\s*\n([\s\S]*?)(?=\n\[|$)/i.exec(content)
  return match ? match[1] : ''
}

function scanPrompt(filePath) {
  const content    = fs.readFileSync(filePath, 'utf8')
  const prompt     = extractSystemPrompt(content)
  if (!prompt) return []

  const findings = []
  for (const { name, pattern } of INJECTION_PATTERNS) {
    const match = pattern.exec(prompt)
    if (match) {
      // Truncate matched text for display — do not log full prompt (could be large)
      findings.push({ type: name, matched: match[0].slice(0, 80) })
    }
  }
  return findings
}

function run() {
  if (!fs.existsSync(PACKS_DIR)) {
    console.log(`[scan-pack-prompts] No packs directory at ${PACKS_DIR} — skipping.`)
    process.exit(0)
  }

  const packFiles = fs
    .readdirSync(PACKS_DIR)
    .filter((f) => f.endsWith('.toml') || f.endsWith('.pack'))
    .map((f) => path.join(PACKS_DIR, f))

  if (packFiles.length === 0) {
    console.log('[scan-pack-prompts] No pack files found — skipping.')
    process.exit(0)
  }

  let violations = 0
  for (const file of packFiles) {
    const findings = scanPrompt(file)
    if (findings.length > 0) {
      for (const f of findings) {
        console.error(`[scan-pack-prompts] SUSPICIOUS: ${path.basename(file)} — ${f.type}: "${f.matched}"`)
      }
      violations++
    }
  }

  if (violations > 0) {
    console.error(`\n[scan-pack-prompts] ${violations} pack(s) contain suspicious prompt patterns.`)
    console.error('Review each flagged pack before publishing to the registry.')
    process.exit(1)
  }

  console.log(`[scan-pack-prompts] OK — ${packFiles.length} pack(s) scanned.`)
}

run()
