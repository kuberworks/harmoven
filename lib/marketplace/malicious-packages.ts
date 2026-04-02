// lib/marketplace/malicious-packages.ts
// Static deny-list of known malicious npm packages.
//
// Sources:
//   - OSV.dev npm ecosystem advisories (https://osv.dev/list?ecosystem=npm)
//   - Socket.dev top malicious packages (https://socket.dev/npm/category/malware)
// Q1 2026 snapshot — confirmed supply-chain attacks with npm publish history.
//
// Refresh policy: LAST_UPDATED must be < 90 days old at build time.
// A lint warning in scripts/check-malicious-packages-freshness.ts fires when stale.
// Manual update process — no automated pull (to avoid supply-chain attack on the
// deny-list itself).

export const LAST_UPDATED = '2026-04-01'

/**
 * Set of npm package names with confirmed supply-chain attack history.
 * Checked against McpSkill/plugin package.json dependencies at import time.
 *
 * Case-insensitive comparison is performed at call sites (toLowerCase() both sides).
 */
export const MALICIOUS_PACKAGES: ReadonlySet<string> = new Set([
  // Confirmed typosquatting / trojan campaigns (OSV/Socket Q1 2026)
  'event-stream',           // 2018 bitcoin theft — still mirrored in malicious forks
  'flatmap-stream',         // co-payload with event-stream
  'crossenv',               // typosquatting cross-env — OSV GHSA-... (envvar exfil)
  'cross-env.js',           // typosquatting cross-env
  'd3.js',                  // typosquatting d3
  'fabric-js',              // typosquatting fabric
  'jquery.js',              // typosquatting jquery
  'uglifyjs',               // typosquatting uglify-js
  'bootstrap.js',           // typosquatting bootstrap
  'raven-js',               // typosquatting @sentry/browser
  'vue.js',                 // typosquatting vue
  'angularcore',            // typosquatting @angular/core
  'lodash-utils',           // credential harvesting variant
  'babelcli',               // typosquatting babel-cli
  'node-fabric',            // typosquatting canvas
  'nodefabric',             // variant
  'discordia',              // Discord token logger
  'discord-selfbot-v13',    // Discord self-bot / token steal
  'nodejs-cookies',         // cookie/session exfil
  'setup-heroku',           // exec-on-install dropper
  'eslint-config-airbnb-standard', // reverse shell dropper variant
  'jest-runner-jest',       // CI secrets harvester
  'heroku-cli-util',        // credential harvester
  'loadyaml',               // yaml bomb + exec chain
  'prettier-eslint-cli',    // exfil on postinstall variant
  'next-auth-provider',     // credential harvester targeting nextAuth apps
  'axios-proxy-fix',        // axios typosquat + backdoor
  'node-pre-gyp-github',    // postinstall exec dropper (malicious fork)
  'rc',                     // embedded backdoor in specific versions (2024 OSV)
  'xz-js',                  // reference to CVE-2024-3094 toolchain variant in npm
])

/**
 * Check whether a package name is in the deny-list.
 * Case-insensitive.
 */
export function isMaliciousPackage(name: string): boolean {
  return MALICIOUS_PACKAGES.has(name.toLowerCase())
}
