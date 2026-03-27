#!/usr/bin/env node
// scripts/validate-pack-tools.js
// Amendment 91 — Detect undeclared tool usage in marketplace pack prompts.
//
// Scans TOML-format pack files in the packs/ directory:
//   - Reads [tools] declared section
//   - Scans system_prompt for tool invocations matching {{tool: <name>}} patterns
//   - Reports any tool invoked in the prompt that is not declared in [tools]
//
// Exit codes:
//   0 = no undeclared tool usage found
//   1 = undeclared tool(s) found (exits 1 so CI can block)
//
// Usage: node scripts/validate-pack-tools.js [--dir packs/]

'use strict'

const fs   = require('fs')
const path = require('path')

const PACKS_DIR = process.argv[2] ?? path.join(process.cwd(), 'packs')

// Pattern for tool invocations in prompt text, e.g. {{tool: run_bash}} or [tool:run_bash]
const TOOL_INVOCATION_PATTERNS = [
  /\{\{tool:\s*([a-z0-9_]+)\s*\}\}/gi,
  /\[tool:\s*([a-z0-9_]+)\s*\]/gi,
  /<tool>\s*([a-z0-9_]+)\s*<\/tool>/gi,
]

// Pattern matching the "declared tools" section in TOML-format packs
// Expects: tools = ["tool_a", "tool_b"]
const TOOLS_DECL_RE = /^tools\s*=\s*\[([^\]]*)\]/m

function extractDeclaredTools(content) {
  const match = TOOLS_DECL_RE.exec(content)
  if (!match) return new Set()
  // Parse the array — split on commas, strip quotes and whitespace
  return new Set(
    match[1]
      .split(',')
      .map((t) => t.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean),
  )
}

function extractUsedTools(systemPrompt) {
  const used = new Set()
  for (const pattern of TOOL_INVOCATION_PATTERNS) {
    let m
    pattern.lastIndex = 0
    while ((m = pattern.exec(systemPrompt)) !== null) {
      used.add(m[1].toLowerCase())
    }
  }
  return used
}

function validatePack(filePath) {
  const content = fs.readFileSync(filePath, 'utf8')
  const declaredTools = extractDeclaredTools(content)

  // Find system_prompt block — between [system_prompt] line and next [...] section
  const promptMatch = /\[system_prompt\]\s*\n([\s\S]*?)(?=\n\[|$)/i.exec(content)
  if (!promptMatch) return []

  const systemPrompt = promptMatch[1]
  const usedTools = extractUsedTools(systemPrompt)

  const undeclared = []
  for (const tool of usedTools) {
    if (!declaredTools.has(tool)) {
      undeclared.push(tool)
    }
  }
  return undeclared
}

function run() {
  if (!fs.existsSync(PACKS_DIR)) {
    // No packs directory — nothing to validate
    console.log(`[validate-pack-tools] No packs directory at ${PACKS_DIR} — skipping.`)
    process.exit(0)
  }

  const packFiles = fs
    .readdirSync(PACKS_DIR)
    .filter((f) => f.endsWith('.toml') || f.endsWith('.pack'))
    .map((f) => path.join(PACKS_DIR, f))

  if (packFiles.length === 0) {
    console.log('[validate-pack-tools] No pack files found — skipping.')
    process.exit(0)
  }

  let violations = 0
  for (const file of packFiles) {
    const undeclared = validatePack(file)
    if (undeclared.length > 0) {
      console.error(`[validate-pack-tools] FAIL: ${path.basename(file)} uses undeclared tools: ${undeclared.join(', ')}`)
      violations++
    }
  }

  if (violations > 0) {
    console.error(`\n[validate-pack-tools] ${violations} pack(s) use undeclared tools.`)
    console.error('Add the tool names to the [tools] section of each failing pack.')
    process.exit(1)
  }

  console.log(`[validate-pack-tools] OK — ${packFiles.length} pack(s) validated.`)
}

run()
