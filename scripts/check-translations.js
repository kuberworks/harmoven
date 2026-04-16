#!/usr/bin/env node
// scripts/check-translations.js
// CI gate — Amendment 88 / T3.5
//
// Verifies fr.json contains every key present in en.json (the canonical source).
// Values are considered missing when:
//   - the key does not exist in fr.json, OR
//   - the value starts with "[TODO-TRANSLATE]"
//
// Nested keys are flattened (dot-notation) for comparison.
//
// Exit codes:
//   0 — fr.json is complete OR locales/ directory does not yet exist (T3.7 pending)
//   1 — one or more keys are missing or untranslated (fails CI)
//
// Usage:
//   node scripts/check-translations.js [--locales-dir <path>]

'use strict'

const fs   = require('node:fs')
const path = require('node:path')

const args        = process.argv.slice(2)
const dirFlagIdx  = args.indexOf('--locales-dir')
const localesDir  = dirFlagIdx !== -1
  ? path.resolve(args[dirFlagIdx + 1])
  : path.resolve(__dirname, '..', 'locales')

// T3.7 not yet implemented — exit 0 gracefully
if (!fs.existsSync(localesDir)) {
  console.log('[translation-check] locales/ not found — skipping (T3.7 pending)')
  process.exit(0)
}

const enFile = path.join(localesDir, 'en.json')
const frFile = path.join(localesDir, 'fr.json')

if (!fs.existsSync(enFile)) {
  console.error('[translation-check] locales/en.json not found')
  process.exit(1)
}
if (!fs.existsSync(frFile)) {
  console.error('[translation-check] locales/fr.json not found — create it with all keys')
  process.exit(1)
}

/**
 * Flatten a nested object to dot-notation keys.
 * E.g. { a: { b: 'x' } } → { 'a.b': 'x' }
 * @param {Record<string, unknown>} obj
 * @param {string} prefix
 * @returns {Record<string, string>}
 */
function flatten(obj, prefix = '') {
  /** @type {Record<string, string>} */
  const result = {}
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flatten(/** @type {Record<string, unknown>} */ (value), fullKey))
    } else {
      result[fullKey] = String(value)
    }
  }
  return result
}

let enRaw, frRaw
try {
  enRaw = JSON.parse(fs.readFileSync(enFile, 'utf8'))
  frRaw = JSON.parse(fs.readFileSync(frFile, 'utf8'))
} catch (e) {
  console.error(`[translation-check] JSON parse error: ${e.message}`)
  process.exit(1)
}

const enFlat = flatten(enRaw)
const frFlat = flatten(frRaw)

const missing    = []
const untranslated = []

for (const [key, enValue] of Object.entries(enFlat)) {
  if (!(key in frFlat)) {
    missing.push(key)
  } else if (frFlat[key].startsWith('[TODO-TRANSLATE]')) {
    untranslated.push(key)
  }
}

const totalEn = Object.keys(enFlat).length

if (missing.length === 0 && untranslated.length === 0) {
  console.log(`[translation-check] ✓ fr.json is complete (${totalEn} keys)`)
  process.exit(0)
}

if (missing.length > 0) {
  console.error(`[translation-check] ✗ ${missing.length} key(s) missing from fr.json:`)
  for (const k of missing) console.error(`  - ${k}`)
}
if (untranslated.length > 0) {
  console.error(`[translation-check] ✗ ${untranslated.length} key(s) still marked [TODO-TRANSLATE]:`)
  for (const k of untranslated) console.error(`  - ${k}`)
}

process.exit(1)
