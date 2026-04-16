#!/usr/bin/env bash
# scripts/build-llm-plugin.sh
# Compiles a Harmoven LLM provider plugin from TypeScript source to plugin.cjs
# and updates content_sha256 in harmoven-plugin.json.
#
# Usage:
#   bash scripts/build-llm-plugin.sh <plugin-dir>
#
# Example (GitHub Copilot plugin):
#   bash scripts/build-llm-plugin.sh lib/llm/plugins/github-copilot
#
# Prerequisites:
#   - esbuild installed: npm install --save-dev esbuild
#   - Plugin source TypeScript files present in <plugin-dir>/
#
# Output:
#   <plugin-dir>/plugin.cjs   ← pre-compiled CommonJS bundle
#   <plugin-dir>/harmoven-plugin.json  ← content_sha256 updated
#
# ── Plugin authoring convention ───────────────────────────────────────────────
# Plugins run in an isolated subprocess (PluginSubprocessBridge). The register()
# function MUST return the ILlmProviderPlugin object so the bridge can access it:
#
#   export function register(): ILlmProviderPlugin {
#     return { providerId, profiles, chat, stream }
#   }
#
# The old side-effect-only convention (calling registerLlmPlugin() internally)
# is NOT supported in subprocess mode — the server's registry is not available
# inside the child process.
#
# API key access: use process.env[profile.api_key_env] as usual. The bridge
# forwards API key env vars to the subprocess while excluding server secrets.

set -euo pipefail

PLUGIN_DIR="${1:-}"

if [[ -z "$PLUGIN_DIR" ]]; then
  echo "Usage: $0 <plugin-dir>" >&2
  echo "Example: $0 lib/llm/plugins/github-copilot" >&2
  exit 1
fi

if [[ ! -d "$PLUGIN_DIR" ]]; then
  echo "Error: directory not found: $PLUGIN_DIR" >&2
  exit 1
fi

MANIFEST="$PLUGIN_DIR/harmoven-plugin.json"
if [[ ! -f "$MANIFEST" ]]; then
  echo "Error: no harmoven-plugin.json found in $PLUGIN_DIR" >&2
  exit 1
fi

ENTRY="$PLUGIN_DIR/index.ts"
if [[ ! -f "$ENTRY" ]]; then
  echo "Error: no index.ts found in $PLUGIN_DIR" >&2
  exit 1
fi

OUTPUT="$PLUGIN_DIR/plugin.cjs"

echo "[build-llm-plugin] Compiling $ENTRY → $OUTPUT"

# Bundle with esbuild — single CJS file, externalize Node.js built-ins only
# The openai SDK and other npm deps are BUNDLED so the plugin.cjs is self-contained.
npx esbuild "$ENTRY" \
  --bundle \
  --platform=node \
  --format=cjs \
  --target=node22 \
  --external:node:* \
  --external:next \
  --outfile="$OUTPUT" \
  --log-level=info

echo "[build-llm-plugin] Bundle written: $OUTPUT ($(wc -c < "$OUTPUT") bytes)"

# Compute SHA-256 and update harmoven-plugin.json
if command -v sha256sum &>/dev/null; then
  SHA=$(sha256sum "$OUTPUT" | awk '{print $1}')
elif command -v shasum &>/dev/null; then
  SHA=$(shasum -a 256 "$OUTPUT" | awk '{print $1}')
else
  echo "Warning: sha256sum / shasum not found — content_sha256 not updated" >&2
  SHA=""
fi

if [[ -n "$SHA" ]]; then
  # Use node to update the JSON so we don't depend on jq
  node -e "
    const fs = require('fs');
    const raw = fs.readFileSync('$MANIFEST', 'utf8');
    const obj = JSON.parse(raw);
    obj.content_sha256 = '$SHA';
    fs.writeFileSync('$MANIFEST', JSON.stringify(obj, null, 2) + '\n', 'utf8');
    console.log('[build-llm-plugin] content_sha256 updated in harmoven-plugin.json:', '$SHA');
  "
fi

echo "[build-llm-plugin] Done. To package as .hpkg for marketplace distribution:"
echo "  zip -j plugin.hpkg $PLUGIN_DIR/manifest.json $PLUGIN_DIR/harmoven-plugin.json $PLUGIN_DIR/plugin.cjs"
echo ""
echo "Note: manifest.json (top-level .hpkg manifest) must list capability_type: llm_provider_plugin"
echo "      and content_sha256 must match the SHA-256 of plugin.cjs."
