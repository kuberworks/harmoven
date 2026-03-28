// lib/security/ssrf-protection.ts
// SSRF (Server-Side Request Forgery) protection for all outbound URLs.
// Spec: Amendment 92 H2.
//
// Attack vector: an admin (or LLM output) sets a custom base_url for
// an LLM provider such as `http://169.254.169.254/latest/meta-data/` or
// `http://localhost:5432/` — these would hit AWS metadata or internal services.
//
// Defence:
//   1. Block non-http(s) protocols (no file://, data://, ftp://)
//   2. DNS-resolve the hostname
//   3. Reject if any resolved IP is in a private/reserved range
//
// Security notes:
//   - DNS resolution happens at validation time; results may change later (DNS rebinding).
//     Mitigation: re-validate on each request or use a fixed resolver. For
//     orchestrator.yaml values (validated at startup + config save) this is
//     a reasonable tradeoff.
//   - IPv6 private ranges are covered (::1, fc00::/7).

import { URL }        from 'node:url'
import * as dns       from 'node:dns/promises'
import { ValidationError } from '@/lib/utils/input-validation'

// ─── Private IP detection ─────────────────────────────────────────────────────

// Returns true if the given IPv4 address string is in a private/reserved range.
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) {
    return false // can't parse — assume safe (caller should handle separately)
  }
  // At this point parts has exactly 4 validated elements; use non-null assertion
  // because TypeScript cannot narrow array access via .length checks.
  const a = parts[0]!
  const b = parts[1]!
  return (
    a === 10 ||                            // 10.0.0.0/8   RFC1918
    (a === 172 && b >= 16 && b <= 31) ||   // 172.16.0.0/12 RFC1918
    (a === 192 && b === 168) ||            // 192.168.0.0/16 RFC1918
    a === 127 ||                           // 127.0.0.0/8  loopback
    (a === 169 && b === 254) ||            // 169.254.0.0/16 link-local (AWS/GCP metadata)
    (a === 100 && b >= 64 && b <= 127) ||  // 100.64.0.0/10 CGNAT
    (a === 0) ||                           // 0.0.0.0/8
    (a === 192 && b === 0 && parts[2] === 0) || // 192.0.0.0/24 IETF protocol
    (a === 198 && (b === 18 || b === 19))  // 198.18.0.0/15 benchmarking
  )
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  return (
    lower === '::1' ||             // loopback
    lower.startsWith('fc') ||      // fc00::/7 ULA (fd00::/8 is included)
    lower.startsWith('fd') ||      // fd00::/8 ULA
    lower.startsWith('fe80:') ||   // fe80::/10 link-local
    lower === '::' ||              // unspecified
    lower.startsWith('::ffff:')    // IPv4-mapped — check the IPv4 part
  )
}

function isPrivateIP(address: string): boolean {
  // IPv4-mapped IPv6 addresses: ::ffff:192.168.1.1
  if (address.startsWith('::ffff:')) {
    return isPrivateIPv4(address.slice('::ffff:'.length))
  }
  if (address.includes(':')) return isPrivateIPv6(address)
  return isPrivateIPv4(address)
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Validate that a URL does not point to a private/internal host.
 * Throws ValidationError if:
 *   - URL is invalid
 *   - Protocol is not http: or https:
 *   - Hostname resolves to a private IP (SSRF block)
 *
 * @throws ValidationError
 */
export async function assertNotPrivateHost(rawUrl: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new ValidationError(`Invalid URL: "${rawUrl.slice(0, 100)}"`)
  }

  // Block non-http(s) protocols
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ValidationError(
      `Blocked protocol: "${parsed.protocol}" — only http/https allowed`
    )
  }

  // Block credentials in URL
  if (parsed.username || parsed.password) {
    throw new ValidationError(
      'Credentials embedded in URL are not allowed'
    )
  }

  // Resolve hostname and check all returned addresses.
  // SECURITY: fail-closed — if DNS resolution fails for any reason (DNS rebinding
  // preparation, misconfigured resolver, network partition), we block the request
  // rather than allow it through. An attacker controlling DNS could suppress
  // resolution during validation and then redirect to a private IP at call time.
  let addresses: { address: string; family: number }[]
  try {
    addresses = await dns.lookup(parsed.hostname, { all: true })
  } catch {
    throw new ValidationError(
      `SSRF blocked: cannot resolve host "${parsed.hostname}" — request rejected`
    )
  }

  for (const { address } of addresses) {
    if (isPrivateIP(address)) {
      throw new ValidationError(
        `SSRF blocked: "${parsed.hostname}" resolves to private IP "${address}"`
      )
    }
  }
}

/**
 * Validate a custom LLM provider base URL.
 * Used when an admin saves a custom base_url in orchestrator.yaml.
 *
 * Calls assertNotPrivateHost() plus additional LLM-specific checks.
 *
 * @throws ValidationError
 */
export async function validateLLMBaseUrl(url: string): Promise<void> {
  if (!url || typeof url !== 'string') {
    throw new ValidationError('LLM base URL must be a non-empty string')
  }
  await assertNotPrivateHost(url)
}
