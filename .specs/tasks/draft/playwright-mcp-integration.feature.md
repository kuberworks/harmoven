---
title: "Playwright MCP — browser automation sidecar for AI agent pipelines"
status: draft
created: 2026-04-14
decomposed: 2026-04-14
depends_on: []
agents_completed: [architect]
agents_pending: []
child_tasks:
  - playwright-mcp-t1-security-host-utils   # (no dep) extract isPrivateLiteralHost
  - playwright-mcp-t2-docker-infra          # (no dep, parallel with T1) Dockerfile + compose + orchestrator.yaml
  - playwright-mcp-t3-mcp-remote-transport  # (dep: T1) McpSkillClient remote transport + validate-config
  - playwright-mcp-t4-enable-browser-flow   # (dep: T3) run-config + API + planner PATTERN E + bootstrap seed
  - playwright-mcp-t5-writer-browser-injection # (dep: T3+T4) runner injection + semaphore + openapi + i18n
---

## Tâches

> Spec architecturale décomposée en 5 tâches atomiques dans `.specs/tasks/todo/`.
> Implémentez dans l'ordre des dépendances — T1 et T2 sont parallélisables.

```
T1 (security)  ──► T3 (MCP client)  ──► T4 (enable_browser flow)  ──► T5 (writer injection)
T2 (docker)        (no dep)
```

| Tâche | Fichiers principaux | Dépend de |
|---|---|---|
| T1 — Security host utils | `lib/security/internal-host.ts` (new), `web-search.ts` | — |
| T2 — Docker infra | `Dockerfile.playwright-mcp` (new), `docker-compose.yml`, `orchestrator.yaml` | — |
| T3 — MCP remote transport | `lib/mcp/client.ts`, `lib/mcp/validate-config.ts` | T1 |
| T4 — Enable-browser flow | `run-config.ts`, `api/runs/route.ts`, `planner.ts`, `seed-builtin-skills.ts` (new), `instrumentation.ts` | T3 |
| T5 — Writer browser injection | `lib/agents/runner.ts`, `writer.ts`, `openapi/v1.yaml`, i18n | T3 + T4 |

---

## Gaps corrigés vs spec initiale

1. **`lib/bootstrap/index.ts` n'existe pas** → T4 crée `lib/bootstrap/seed-builtin-skills.ts` + appel dans `instrumentation.ts`
2. **`async-mutex` non installé** → semaphore 1-slot manuel dans T5 (runner.ts, ~10 lignes, sans dépendance)
3. **Flow `enable_browser`** → T4 suit exactement le pattern de `enable_web_search` (runner.ts ligne 468 + run-config.ts + API route)
4. **PATTERN E manquant** → T4 ajoute la guidance browser dans le prompt du planner (parallèle à PATTERN D)
5. **`listToolsWithSchemas()` manquant dans client.ts** → ajouté en T3 (pas T5)

---

## Référence architecturale (voir ci-dessous pour le détail)

## Vue d'ensemble

Intégrer `@playwright/mcp` pour permettre aux nœuds WRITER d'exécuter des
actions de navigation / scraping / interaction browser dans le cadre d'un
pipeline run.  
Exemple de cas d'usage : « Compare les tarifs des 3 premiers résultats pour X
et génère un tableau CSV. »

---

## ⚠️ Analyse critique — pourquoi la première approche évidente est mauvaise

### Solution naïve à REJETER : MCP skill via `npx @playwright/mcp`

Un administrateur pourrait enregistrer `npx @playwright/mcp@latest` en tant
que skill MCP via l'UI admin/integrations. Techniquement, `npx` est dans
`ALLOWED_MCP_COMMANDS` — la validation passerait.

**Pourquoi cette approche doit être bloquée :**

| Problème | Conséquence |
|---|---|
| Chrome spawné dans le container `app` (uid nextjs) | Aucune isolation namespace — le browser partage le PID tree de l'app |
| `+600 MB` d'image Docker (Chromium + dépendances) | Image de prod qui grossit pour tous les déploiements, même sans browser |
| N runs concurrents → N processus Chrome | OOM garanti sur un hôte à 2–4 GB RAM |
| Browser a accès à `localhost:3000` et `db:5432` depuis l'intérieur du container | SSRF interne triviale sans `--internal` network |
| Pas de `shm_size` configuré | Chrome crashe immédiatement sur Alpine sans `/dev/shm` suffisant |
| `McpSkillClient` réutilise la connexion stdio — mais un crash Chrome la tue | Connexion corrompue en cache, aucune reconnection |

**Conséquence d'implémentation** : ajouter `@playwright/mcp` dans la blocklist
implicite de la validation skill, ou mieux, créer un type de transport `remote`
qui court-circuite le flux stdio.

---

## Architecture retenue : sidecar Docker isolé (modèle LiteLLM)

```
┌─────────────────────────────────────┐     playwright_net (bridge)
│  app container                      │ ──────────────────────────► playwright-mcp
│  McpSkillClient                     │           HTTP :3100              │
│  StreamableHTTPClientTransport      │◄──────────────────────────────────┘
│  (nouveau transport type "remote")  │
└─────────────────────────────────────┘
         │ app_net
         ▼
        db:5432   (playwright-mcp n'est PAS sur app_net → DB injoignable)
```

**Principes :**
- Service `playwright-mcp` dans `docker-compose.yml` sous `--profile playwright-mcp`
- Image officielle Microsoft avec Chromium pré-installé (digest pined)
- Ressources bornées via Docker : `mem_limit`, `cpus`, `shm_size`
- Réseau `playwright_net` dédié (bridge, accès internet OUI — le browser en a besoin)
- `playwright-mcp` n'est PAS sur `app_net` → ne peut pas joindre `db:5432`
- `app` est sur `playwright_net` ET `app_net` (pour joindre le sidecar)
- Opt-in via `orchestrator.yaml` flag `playwright_mcp.enabled: false`

---

## SSRF via browser — risque résiduel et mitigation

Même avec isolation réseau, le LLM peut demander :
`browser_navigate("http://app:3000/api/admin/...")`  
→ `app` est sur `playwright_net`, donc joignable depuis le browser.

**Mitigation requise (implémentation obligatoire) :**

Dans `lib/mcp/client.ts` (ou une nouvelle couche proxy avant l'envoi du tool
call au sidecar), valider les arguments `url` des outils `browser_navigate`,
`browser_goto`, `page_goto` contre la même liste de blocs privés que
`lib/agents/tools/web-search.ts` + une blocklist des hostnames Docker internes :
`app`, `db`, `litellm`, `redis`, `docker-proxy`, `localhost`, `127.0.0.1`,
`::1`, `10.*`, `172.16-31.*`, `192.168.*`.

---

## Implémentation — étapes

### Phase 1 — Docker Compose sidecar

**Fichier : `docker-compose.yml`**

Ajouter après le service `marketplace-cron` :

```yaml
  playwright-mcp:
    # Image officielle Playwright — Chromium pré-installé, dépendances OS correctes.
    # Pinner par digest dans .env : PLAYWRIGHT_MCP_DIGEST=sha256:<digest>
    # docker pull mcr.microsoft.com/playwright:v1.50.0 && \
    #   docker inspect --format='{{index .RepoDigests 0}}' mcr.microsoft.com/playwright:v1.50.0
    image: mcr.microsoft.com/playwright@${PLAYWRIGHT_MCP_DIGEST:-sha256:0000000000000000000000000000000000000000000000000000000000000000}
    # Image dérivée — @playwright/mcp pré-installé en version pinnée.
    # Construire avec : docker build -f Dockerfile.playwright-mcp -t harmoven-playwright-mcp:0.0.70 .
    # Fournir le digest dans .env : PLAYWRIGHT_MCP_DIGEST=sha256:<digest de l'image builée>
    # Dockerfile.playwright-mcp (à créer à la racine du projet) :
    #   FROM mcr.microsoft.com/playwright:v1.50.0
    #   RUN npm install -g @playwright/mcp@0.0.70
    command:
      - node
      - /usr/local/lib/node_modules/@playwright/mcp/cli.js
      - --port=3100
      - --host=0.0.0.0
      - --headless
      - --isolated    # profil browser en mémoire (ne persiste pas sur disque)
      - --no-sandbox  # requis dans container sans SYS_ADMIN — JAMAIS en dehors de Docker
    environment:
      # Aucun secret app, DB, LLM ne doit figurer ici.
      - NODE_ENV=production
    networks:
      - playwright_net
    deploy:
      resources:
        limits:
          memory: 1g
          cpus: "0.5"
    # shm_size requis : Chrome crash sans /dev/shm suffisant (défaut 64 MB insuffisant).
    shm_size: 256m
    restart: unless-stopped
    healthcheck:
      # Pas de endpoint /health — le serveur expose /mcp (HTTP streamable) et /sse (legacy).
      # TCP check : port ouvert = serveur prêt.
      test: ["CMD-SHELL", "node -e \"require('net').createConnection(3100,'localhost').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))\""]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
    profiles:
      - playwright-mcp   # docker compose --profile playwright-mcp up
```

Ajouter `playwright_net` au service `app` :
```yaml
    networks:
      - app_net
      - litellm_net
      - playwright_net   # ← nouveau
```

Déclarer le réseau en bas de fichier :
```yaml
  playwright_net:
    # browser_net — app → sidecar only.
    # NOT internal: le browser a besoin d'internet pour naviguer.
    # playwright-mcp n'est PAS sur app_net donc ne peut pas atteindre db:5432.
    driver: bridge
```

---

### Phase 2 — Transport HTTP dans `McpSkillClient`

**Fichier : `lib/mcp/client.ts`**

Le client actuel instancie uniquement `StdioClientTransport`. Il faut un
discriminated union sur le config type.

Étendre `McpSkillConfig` :

```ts
type McpSkillConfig =
  | {
      type: 'stdio'
      command: string
      args?: string[]
      env?: Record<string, string>
    }
  | {
      type: 'remote'
      url: string   // ex: "http://playwright-mcp:3100"
      // Pas de command/args — pas de subprocess local.
    }
```

Dans `getClient()`, brancher selon le type :

```ts
if (config.type === 'remote') {
  // Pas de validation ALLOWED_MCP_COMMANDS (pas de subprocess).
  // Validation SSRF : rejeter les hosts Docker internes (voir lib/security/internal-host.ts).
  assertNotInternalHost(config.url)  // extrait dans Phase 0 (security refactor)
  // URL doit inclure le path /mcp : ex. "http://playwright-mcp:3100/mcp"
  // @playwright/mcp expose /mcp (HTTP streamable, primaire) et /sse (legacy).
  const transport = new StreamableHTTPClientTransport(new URL(config.url))
  const client = new Client({ name: 'harmoven', version: '1.0' })
  await client.connect(transport)
  _clients.set(skillId, client)
  return client
}
// ... chemin stdio existant inchangé
```

Import à ajouter :
```ts
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
// Note : le fichier s'appelle streamableHttp.js (camelCase) dans @modelcontextprotocol/sdk@1.28.0
```

**Important :** `assertNotInternalHost` doit rejeter les hostnames Docker
internes listés dans la section SSRF ci-dessus. La fonction peut être
factorisée dans `lib/security/` et réutilisée depuis `web-search.ts`.

---

### Phase 3 — Skill pré-enregistré "browser" (built-in)

Au lieu de laisser un admin enregistrer `@playwright/mcp` comme skill
arbitraire, le créer en tant que **built-in skill** lors du bootstrap,
conditionnel au flag `playwright_mcp.enabled` dans `orchestrator.yaml`.

**Fichier : `lib/bootstrap/index.ts`** (ou équivalent — vérifier le fichier de
seed/init existant)

```ts
if (config.playwright_mcp?.enabled) {
  await db.mcpSkill.upsert({
    where:  { id: 'builtin-playwright-browser' },
    create: {
      id:          'builtin-playwright-browser',
      name:        'Browser (Playwright)',
      enabled:     true,
      scan_status: 'passed',    // built-in, pas de scan tiers
      config: {
        type: 'remote',
        // URL complète incluant le path /mcp (endpoint HTTP streamable de @playwright/mcp)
        url:  process.env.PLAYWRIGHT_MCP_URL ?? 'http://playwright-mcp:3100/mcp',
      },
    },
    update: { enabled: true },
  })
}
```

---

### Phase 4 — Validation skill à l'installation

**Fichier : `lib/mcp/validate-config.ts`**

Étendre `validateMcpConfig()` pour accepter le type `remote` :
- Si `type === 'remote'` : valider que `url` est un string, que le protocole
  est `http:` ou `https:`, et appeler `assertNotInternalHost`.
- Si `type === 'stdio'` (ou legacy sans `type`) : chemin existant inchangé.
- Si `type` est absent : traiter comme `stdio` (rétrocompat).

Également : ajouter `@playwright/mcp` à une **blocklist explicite** dans
`validateMcpConfig()` pour les skills de type stdio, avec message d'erreur
clair : _"@playwright/mcp must be configured as a built-in remote skill, not a
stdio skill — see orchestrator.yaml playwright_mcp.enabled"_.

---

### Phase 5 — Injection outils browser dans le WRITER

**Fichier : `lib/agents/writer.ts`**

Condition d'activation : `node.metadata?.browser_enabled === true` ET skill
`builtin-playwright-browser` activé dans la DB.

**Pont MCP → LLM tool definitions (étape la plus complexe) :**

Le `ToolInjectionLLMClient` attend des outils au format LLM natif :
```ts
{ name: string, description: string, input_schema: { type: 'object', properties: {...} } }
```
Les outils MCP arrivent avec leur schema via `client.listTools()` du MCP SDK
(pas seulement les noms). Le built-in skill `builtin-playwright-browser` expose
les outils de `@playwright/mcp` — vérifier les noms exacts avec `mcpSkillClient.listTools()`.
Les outils principaux attendus : `browser_navigate`, `browser_snapshot`, `browser_click`,
`browser_type`, `browser_close`.

```ts
// Dans writer.ts — avant d'appeler ToolInjectionLLMClient :
const rawTools = await mcpSkillClient.listToolsWithSchemas('builtin-playwright-browser')
// rawTools : { name, description, inputSchema }[] — depuis le SDK MCP (listTools())
const browserToolDefs = rawTools.map(t => ({
  name:         t.name,
  description:  t.description,
  input_schema: t.inputSchema ?? { type: 'object', properties: {} },
}))
// Puis injecter dans ToolInjectionLLMClient comme les outils web_search existants
```

`mcpSkillClient` doit exposer une méthode `listToolsWithSchemas(skillId)` retournant
le résultat complet de `client.listTools()` (schemas inclus) — à ajouter dans
`lib/mcp/client.ts`.

**Semaphore 1-slot pour l'isolation de session :**
```ts
// lib/execution/browser-semaphore.ts
import { Semaphore } from 'async-mutex' // ou implémentation manuelle avec Promise queue
export const browserSemaphore = new Semaphore(1)
```
Acquérir avant d'exécuter un nœud `browser_enabled`, relâcher dans `finally`.

Ne pas injecter si `anthropicNativeWebSearch=true` (conflit de transport).

Limiter les appels browser par nœud : max `playwright_mcp.max_nav_per_node` (défaut 10).

---

### Phase 0 (prérequis) — URL blocklist centralisée (refactoring sécurité)

> **À implémenter EN PREMIER** — requis par Phase 2 et Phase 4.

**Nouveau fichier : `lib/security/internal-host.ts`**

**Nouveau fichier : `lib/security/internal-host.ts`**

Extraire la logique `isPrivateLiteralHost` de `lib/agents/tools/web-search.ts`
dans ce module partagé. L'import dans `web-search.ts`, `lib/mcp/client.ts`, et
`validate-config.ts` depuis ce module unique.

---

### Phase 7 — orchestrator.yaml

Ajouter la section :

```yaml
playwright_mcp:
  enabled: false
  max_nav_per_node: 10
  # PLAYWRIGHT_MCP_DIGEST doit être défini dans .env quand enabled: true
```

---

### Phase 8 — openapi/v1.yaml

Documenter :
- Le champ `browser_enabled` dans le metadata des nœuds WRITER
- Le skill built-in `builtin-playwright-browser` (visible via `GET /api/admin/integrations`)
- Ajouter note sur le flag `playwright_mcp.enabled` dans la description de l'endpoint runs

---

## Ce qui est hors scope (à ne PAS implémenter)

- Mode `headful` (avec écran) — dégrade les ressources et n'est pas utile en prod
- Expose le port 3100 sur l'hôte — utiliser uniquement le réseau Docker interne
- Monter le socket Docker dans le sidecar Playwright
- Permettre l'enregistrement de `@playwright/mcp` comme skill stdio via l'UI admin
- Playwright comme outil de génération de tests automatisés (cas d'usage distinct, non demandé)
- Multi-instance de Playwright (une session par run) — trop coûteux ; pool ou single instance d'abord

---

## Critères d'acceptation

- [ ] `docker compose --profile playwright-mcp up` démarre le sidecar sans erreur
- [ ] Le port 3100 est joignable depuis le container `app` (TCP + POST `/mcp` retourne 200)
- [ ] Memory + CPU du sidecar respectent les limites définies sous charge (1 run actif)
- [ ] Un WRITER avec `browser_enabled: true` peut appeler `browser_navigate` et recevoir le snapshot de la page
- [ ] Un appel `browser_navigate("http://app:3000")` est rejeté par la blocklist interne
- [ ] Un appel `browser_navigate("http://db:5432")` est rejeté (réseau + blocklist)
- [ ] `validateMcpConfig` rejette `npx @playwright/mcp` comme commande stdio avec message clair
- [ ] `npx tsc --noEmit` passe sans erreurs
- [ ] `npx jest --passWithNoTests --no-coverage` passe sans régression
- [ ] `playwright_mcp.enabled: false` dans orchestrator.yaml → le skill built-in n'est pas créé en DB

---

## Points de vigilance — faits vérifiés (2026-04-14)

1. **`StreamableHTTPClientTransport` — CORRECT. URL = `http://playwright-mcp:3100/mcp`.**
   Confirmé par le log de démarrage du serveur :
   ```
   Listening on http://localhost:3100
   Put this in your client config: { "url": "http://localhost:3100/mcp" }
   For legacy SSE transport support, you can use the /sse endpoint instead.
   ```
   Le serveur expose `/mcp` (HTTP streamable, primaire) et `/sse` (legacy).
   `StreamableHTTPClientTransport` est la bonne classe. Import (fichier camelCase) :
   ```ts
   import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
   ```
   L'URL dans le config du skill doit inclure `/mcp` : `http://playwright-mcp:3100/mcp`.
   `SSEClientTransport` fonctionne aussi mais sur le chemin legacy — ne pas utiliser.

2. **`--isolated` = profil disque en mémoire, PAS isolation de session MCP.**
   `@playwright/mcp@0.0.70` partage un seul contexte browser entre toutes les connexions.  
   Solution retenue : **semaphore 1-slot** dans `lib/execution/custom/executor.ts` — un seul
   nœud `browser_enabled` peut s'exécuter à la fois. Simple, suffisant en v1, pas de
   multi-session prématurée.

3. **`shm_size: '256m'` est VALIDE en Docker Compose v2.35.x.**
   Testé : `docker compose config` retourne `shm_size: "268435456"`. Aucun `sysctls` alternatif.

4. **`--no-sandbox` dans Docker** : nécessaire sans `SYS_ADMIN`. Documenter le compromis
   dans `docker-compose.yml`. Ne jamais utiliser en dehors du container.

5. **`Dockerfile.playwright-mcp` requis (déjà spécifié en Phase 1).**
   `mcr.microsoft.com/playwright:v1.50.0` n'inclut pas `@playwright/mcp`. Le `Dockerfile.playwright-mcp`
   pré-installe `@playwright/mcp@0.0.70` en version pinnée. Digest résultant à fournir dans `.env`.
