---
title: "Playwright MCP — T3: MCP remote transport (client.ts + validate-config.ts)"
status: todo
created: 2026-04-14
depends_on: [playwright-mcp-t1-security-host-utils]
agents_completed: []
agents_pending: [implementer]
---

## Objectif

Ajouter un second type de transport dans `McpSkillClient` : `remote` (HTTP
streamable via `StreamableHTTPClientTransport`) en plus du `stdio` existant.
Étendre `validateMcpConfig()` pour valider les skills `remote` et bloquer
explicitement `@playwright/mcp` en tant que skill stdio.

**Dépend de T1** (pour `assertNotInternalHost`).  
**Ne pas modifier** le chemin stdio existant — aucune régression possible.

---

## Contexte actuel

- `McpSkillConfig` n'a pas de champ `type` — il suppose toujours `stdio`.
- `getClient()` crée toujours un `StdioClientTransport`.
- `listTools()` retourne uniquement `string[]` — pas de schemas.
- `validateMcpConfig()` ne connaît que le type stdio.
- `@modelcontextprotocol/sdk@1.28.0` est installé et inclut `StreamableHTTPClientTransport`
  dans `client/streamableHttp.js` (camelCase — important pour l'import).

---

## Changements

### `lib/mcp/client.ts`

**1. Étendre le type `McpSkillConfig` en discriminated union :**

```ts
type McpSkillConfig =
  | {
      type?: 'stdio' | undefined   // rétrocompat : config sans `type` = stdio
      command: string
      args?: string[]
      env?: Record<string, string>
    }
  | {
      type: 'remote'
      url: string    // doit inclure /mcp : ex. "http://playwright-mcp:3100/mcp"
    }
```

**2. Ajouter l'import `StreamableHTTPClientTransport` :**

```ts
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
// Note : fichier camelCase — ne pas écrire streamable-http.js (tiret = module introuvable)
```

**3. Ajouter `import { assertNotInternalHost } from '@/lib/security/internal-host'`**

**4. Dans `getClient()`, brancher selon `config.type` avant la validation stdio :**

```ts
// Branche remote — avant le check ALLOWED_MCP_COMMANDS
if (config.type === 'remote') {
  // Pas de subprocess. Pas de ALLOWED_MCP_COMMANDS. Pas de mcpSkillEnv().
  // Validation SSRF : rejeter les hosts Docker internes.
  assertNotInternalHost(config.url)
  const transport = new StreamableHTTPClientTransport(new URL(config.url))
  const client = new Client({ name: 'harmoven', version: '1.0' })
  await client.connect(transport)
  _clients.set(skillId, client)
  return client
}
// Chemin stdio — inchangé à partir d'ici
```

**5. Ajouter `listToolsWithSchemas()` à `mcpSkillClient` :**

```ts
/**
 * List tools with their full JSON schemas.
 * Used to bridge MCP tool definitions to the LLM tool-call format.
 */
async listToolsWithSchemas(skillId: string): Promise<Array<{
  name:        string
  description: string
  inputSchema: Record<string, unknown>
}>> {
  const client = await getClient(skillId)
  const { tools } = await client.listTools()
  return tools.map((t: { name: string; description?: string; inputSchema?: unknown }) => ({
    name:        t.name,
    description: t.description ?? '',
    inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
  }))
},
```

### `lib/mcp/validate-config.ts`

**1. Ajouter le support du type `remote` dans `validateMcpConfig()` :**

```ts
// Au début de validateMcpConfig(), avant le check `command` :
if ('type' in c && c['type'] === 'remote') {
  const url = c['url']
  if (typeof url !== 'string' || !url) return 'Remote skill config must have a non-empty "url" string.'
  let parsed: URL
  try { parsed = new URL(url) } catch { return `Remote skill "url" is not a valid URL: ${url}` }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Remote skill "url" must use http: or https: protocol.`
  }
  // Import assertNotInternalHost depuis lib/security/internal-host
  try { assertNotInternalHost(url) } catch (e) {
    return `Remote skill "url" targets a blocked internal host: ${parsed.hostname}`
  }
  return null  // valid
}
```

**2. Bloquer `@playwright/mcp` comme commande stdio :**

Ajouter dans la section de validation `args` / après la validation `command` :

```ts
// Bloquer @playwright/mcp comme skill stdio — doit passer par le type remote built-in.
const argsFlat = (c['args'] as string[] | undefined ?? []).join(' ')
if (argsFlat.includes('@playwright/mcp')) {
  return '@playwright/mcp must be used as the built-in remote skill, not a stdio skill. '
    + 'See orchestrator.yaml playwright_mcp.enabled.'
}
```

---

## Points critiques

- **URL complète avec `/mcp`** : le config du skill doit stocker l'URL incluant le path
  `/mcp` — ex. `"http://playwright-mcp:3100/mcp"`. `@playwright/mcp` expose `/mcp`
  (HTTP streamable primaire) et `/sse` (legacy). `StreamableHTTPClientTransport` attend
  une URL complète et l'utilise telle quelle.
- **Cache partagé** : `_clients` est une Map<string, Client>. Les skills `remote` sont
  mis en cache exactement comme les skills `stdio`. Pas de changement de logique.
- **`disconnect()`** fonctionne identiquement pour les deux types — appelle `client.close()`.

---

## Tests

Fichier : `tests/mcp/remote-transport.test.ts`

Cas à couvrir (avec mock `StreamableHTTPClientTransport`) :
- `getClient()` crée un `StreamableHTTPClientTransport` quand `config.type === 'remote'`
- `getClient()` crée un `StdioClientTransport` quand `config.type` est absent
- `getClient()` throws `SkillNotApprovedError` si `assertNotInternalHost` lance
- `listToolsWithSchemas()` retourne `name + description + inputSchema` mappés
- `validateMcpConfig({ type: 'remote', url: 'http://playwright-mcp:3100/mcp' })` → null (valid)
- `validateMcpConfig({ type: 'remote', url: 'http://db:5432' })` → string (blocked)
- `validateMcpConfig({ command: 'npx', args: ['@playwright/mcp'] })` → string (blocked)

---

## Critères d'acceptation

- [ ] `lib/mcp/client.ts` : discriminated union `McpSkillConfig` avec `type: 'remote'`
- [ ] `lib/mcp/client.ts` : `getClient()` branche `remote` avec `StreamableHTTPClientTransport` + `assertNotInternalHost`
- [ ] `lib/mcp/client.ts` : `listToolsWithSchemas()` exposée sur `mcpSkillClient`
- [ ] `lib/mcp/validate-config.ts` : type `remote` accepté et validé
- [ ] `lib/mcp/validate-config.ts` : `@playwright/mcp` bloqué en stdio avec message clair
- [ ] Chemin stdio existant **inchangé** — aucune régression
- [ ] `npx tsc --noEmit` passe sans erreur
- [ ] `npx jest --passWithNoTests --no-coverage` passe
