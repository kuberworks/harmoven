---
title: "Playwright MCP — T1: Security host utils (isPrivateLiteralHost centralisé)"
status: todo
created: 2026-04-14
depends_on: []
agents_completed: []
agents_pending: [implementer]
---

## Objectif

Extraire `isPrivateLiteralHost` et la liste des hostnames Docker internes dans
un module partagé `lib/security/internal-host.ts`. Ce module est requis par T3
(MCP client) et T4 (validate-config). Sans ce préalable, chaque module
ré-implémenterait la logique SSRF.

---

## État actuel

`isPrivateLiteralHost` existe dans `lib/agents/tools/web-search.ts` — elle est
correcte (inclut `::ffff:` IPv4-mapped, compact IPv6, ranges RFC 1918) mais
locale au module web-search.

Les hostnames Docker internes (`app`, `db`, `litellm`, `redis`, etc.) ne sont
nulle part centralisés.

---

## Changements

### Nouveau fichier : `lib/security/internal-host.ts`

```ts
/**
 * lib/security/internal-host.ts
 * Shared SSRF protection utilities — structural host validation only (no DNS).
 */

/**
 * Returns true if the hostname is provably a private/loopback/link-local address
 * using structural inspection only (no DNS resolution).
 * Handles IPv4, IPv6, IPv4-mapped IPv6 (::ffff:192.168.x.x), brackets.
 */
export function isPrivateLiteralHost(host: string): boolean { /* move from web-search.ts */ }

/**
 * Docker-internal service hostnames that must never be the target of
 * browser navigation or remote MCP URLs.
 */
export const DOCKER_INTERNAL_HOSTNAMES = new Set([
  'app', 'db', 'litellm', 'redis', 'docker-proxy', 'host.docker.internal',
  'playwright-mcp',
])

/**
 * Returns true if the host should be blocked as an internal target.
 * Combines isPrivateLiteralHost and DOCKER_INTERNAL_HOSTNAMES.
 */
export function isInternalHost(host: string): boolean {
  return isPrivateLiteralHost(host) || DOCKER_INTERNAL_HOSTNAMES.has(host.toLowerCase())
}

/**
 * Throws if the URL hostname is internal/private.
 * Used at skill config validation time and MCP client connect time.
 */
export function assertNotInternalHost(urlString: string): void {
  let parsed: URL
  try { parsed = new URL(urlString) } catch { throw new Error(`Invalid URL: ${urlString}`) }
  if (isInternalHost(parsed.hostname)) {
    throw new Error(`Blocked internal host: ${parsed.hostname}`)
  }
}
```

### `lib/agents/tools/web-search.ts`

- Supprimer la déclaration locale de `isPrivateLiteralHost`
- Ajouter `import { isPrivateLiteralHost } from '@/lib/security/internal-host'`
- Le reste du fichier est **inchangé**

---

## Tests

Fichier : `tests/security/internal-host.test.ts`

Cas à couvrir :
- `isPrivateLiteralHost('127.0.0.1')` → true
- `isPrivateLiteralHost('192.168.1.1')` → true
- `isPrivateLiteralHost('10.0.0.1')` → true
- `isPrivateLiteralHost('::ffff:192.168.1.1')` → true (IPv4-mapped)
- `isPrivateLiteralHost('::1')` → true
- `isPrivateLiteralHost('fc00::1')` → true
- `isPrivateLiteralHost('8.8.8.8')` → false
- `isPrivateLiteralHost('example.com')` → false
- `isInternalHost('db')` → true
- `isInternalHost('app')` → true
- `isInternalHost('example.com')` → false
- `assertNotInternalHost('http://db:5432')` → throws
- `assertNotInternalHost('https://example.com')` → no throw

---

## Critères d'acceptation

- [ ] `lib/security/internal-host.ts` créé et exportant `isPrivateLiteralHost`, `isInternalHost`, `assertNotInternalHost`, `DOCKER_INTERNAL_HOSTNAMES`
- [ ] `lib/agents/tools/web-search.ts` importe depuis `@/lib/security/internal-host` (plus de déclaration locale)
- [ ] `npx tsc --noEmit` passe sans erreur
- [ ] `npx jest tests/security/internal-host.test.ts` passe
- [ ] Aucune régression sur `npx jest --passWithNoTests --no-coverage`
