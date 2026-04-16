---
title: "Playwright MCP — T4: Enable-browser flow (run-config + API + planner + bootstrap)"
status: todo
created: 2026-04-14
depends_on: [playwright-mcp-t3-mcp-remote-transport]
agents_completed: []
agents_pending: [implementer]
---

## Objectif

Faire circuler le flag `enable_browser` depuis la requête API jusqu'aux nodes
WRITER (via `run_config`), ajouter le PATTERN E dans le prompt du planner,
et enregistrer le skill built-in au démarrage si `playwright_mcp.enabled`.

**Dépend de T3** (pour que le type `remote` existe dans `lib/mcp/client.ts`).

---

## Contexte — pattern enable_web_search (à reproduire exactement)

Le mécanisme `enable_web_search` déjà implémenté est le modèle de référence :

| Étape | Fichier | What |
|---|---|---|
| 1 | `app/api/runs/route.ts` | `enable_web_search: z.boolean().optional().default(false)` dans le schema Zod → stocké dans `run_config` JSON |
| 2 | `lib/execution/run-config.ts` | `RunConfigSchema` a `enable_web_search` |
| 3 | `lib/agents/planner.ts` | Signal dans le message user : `enable_web_search: true` |
| 4 | `lib/agents/runner.ts` | `runConfig.enable_web_search === true` → `enable_web_search: true` dans `WriterNodeInput` |
| 5 | `lib/agents/writer.ts` | `node.enable_web_search` active les outils web |

Le même pattern s'applique à `enable_browser` → `browser_enabled`.
**T5 s'occupe des étapes 4–5** (runner + writer). Cette tâche couvre les étapes 1–3 + bootstrap.

---

## Changements

### 1. `lib/execution/run-config.ts`

Ajouter dans `RunConfigSchema` :

```ts
enable_browser: z.boolean().optional().default(false),
```

Mettre à jour `parseRunConfig` (le fallback default) :

```ts
return result.success ? result.data : { enable_web_search: false, enable_browser: false }
```

### 2. `app/api/runs/route.ts`

Dans le schema Zod `CreateRunBody` (après `enable_web_search`) :

```ts
enable_browser: z.boolean().optional().default(false),
```

Dans la construction du `run_config` stocké en DB (après la ligne `enable_web_search`) :

```ts
...(body.enable_browser ? { enable_browser: true } : {}),
```

### 3. `lib/agents/planner.ts`

**Signal dans le message user** (après le spread `enable_web_search`) :

```ts
...(runConfigPre.enable_browser ? { enable_browser: true } : {}),
```

**PATTERN E dans le prompt système** — après PATTERN D (WEB RESEARCH) :

```
PATTERN E — BROWSER AUTOMATION (task = "navigate / interact / scrape a specific URL or web interface"):
- TRIGGER: enable_browser = true AND the task requires controlling a real browser
  (clickable UI, JavaScript-heavy page, login wall, visual interaction, file download from web).
- Plan: one WRITER node per browser session.
- The WRITER has built-in browser tools (browser_navigate, browser_snapshot, browser_click,
  browser_type, browser_close). It calls them itself — you do NOT need to orchestrate it.
- DO NOT use PYTHON_EXECUTOR for browser tasks — Pyodide has no network access.
- WHEN enable_browser = false: do NOT produce nodes that depend on browser tools.
```

> Ne pas modifier PATTERN D — ils sont complémentaires (PATTERN D = recherche d'infos
> via API de recherche, PATTERN E = contrôle d'interface web réelle).

### 4. `lib/bootstrap/seed-builtin-skills.ts` (nouveau fichier)

```ts
// lib/bootstrap/seed-builtin-skills.ts
// Seeds built-in MCP skill records at server startup.
// Currently: builtin-playwright-browser (when playwright_mcp.enabled).

import { db }          from '@/lib/db/client'
import { loadConfig }  from '@/lib/config-git/loader'   // ou équivalent existant

export async function seedBuiltinSkills(): Promise<void> {
  const config = await loadConfig()   // ← utiliser la fonction existante de config-git

  if (config?.playwright_mcp?.enabled) {
    const url = process.env.PLAYWRIGHT_MCP_URL ?? 'http://playwright-mcp:3100/mcp'
    await db.mcpSkill.upsert({
      where:  { id: 'builtin-playwright-browser' },
      create: {
        id:          'builtin-playwright-browser',
        name:        'Browser (Playwright)',
        enabled:     true,
        scan_status: 'passed',  // built-in — pas de scan tiers
        config: JSON.parse(JSON.stringify({ type: 'remote', url })),
        source_type: 'builtin',
      },
      update: { enabled: true, config: JSON.parse(JSON.stringify({ type: 'remote', url })) },
    })
    console.log('[bootstrap] builtin-playwright-browser skill registered')
  }
}
```

> **Important** : vérifier le nom exact de la fonction `loadConfig` / le module
> de config qui parse `orchestrator.yaml`. Chercher dans `lib/config-git/` ou
> `lib/bootstrap/sync-instance-config.ts` comment `orchestrator.yaml` est lu.
> Utiliser le même import — ne pas créer un second lecteur YAML.

**Champs `source_type`** : vérifier si le modèle Prisma `McpSkill` a ce champ.
Si absent, l'omettre. Le `id` unique suffit pour identifier un built-in.

### 5. `instrumentation.ts`

Dans la fonction `register()`, après `verifyMCPSkillsFromConfig()` :

```ts
const { seedBuiltinSkills } = await import('@/lib/bootstrap/seed-builtin-skills')
await seedBuiltinSkills().catch((err: unknown) =>
  console.warn('[bootstrap] seedBuiltinSkills failed (non-fatal):', err),
)
```

---

## Points critiques

- **Tolérance de panne** : `seedBuiltinSkills` est non-bloquant (`.catch(warn)`).
  Si le sidecar n'est pas démarré au moment du bootstrap, ça n'empêche pas le serveur
  de démarrer. La connexion MCP se fait lazily dans `getClient()`, pas au upsert.
- **Vérifier `source_type`** : le champ `source_type` est présent dans `upload-hpkg.ts`
  (`source_type: 'upload'`). Vérifier si c'est un enum ou string dans le schema Prisma
  et si `builtin` est une valeur valide.
- **`loadConfig`** : chercher la fonction existante dans `lib/config-git/` ou dans
  `lib/bootstrap/sync-instance-config.ts` avant de créer quoi que ce soit.

---

## Champs d'investigation obligatoires avant implémentation

```bash
# 1. Trouver la fonction qui lit orchestrator.yaml :
grep -rn "orchestrator\.yaml\|loadConfig\|parseConfig\|readConfig" lib/ --include="*.ts" | grep -v node_modules | head -20

# 2. Vérifier si source_type existe dans McpSkill :
grep -n "source_type\|McpSkill" prisma/schema.prisma

# 3. Vérifier runConfigPre dans planner.ts (nom de la variable) :
grep -n "runConfigPre\|parseRunConfig" lib/agents/planner.ts | head -10
```

---

## Tests

Fichier : `tests/api/runs-enable-browser.test.ts` (modèle : `tests/api/runs-web-search.test.ts`)

Cas :
- `POST /api/runs` avec `enable_browser: true` → `run_config.enable_browser === true`
- `POST /api/runs` sans `enable_browser` → `run_config.enable_browser` absent (default false)

---

## Critères d'acceptation

- [ ] `lib/execution/run-config.ts` : `enable_browser` dans `RunConfigSchema`
- [ ] `app/api/runs/route.ts` : `enable_browser` dans le body Zod + stocké dans `run_config`
- [ ] `lib/agents/planner.ts` : PATTERN E ajouté, signal `enable_browser` dans user message
- [ ] `lib/bootstrap/seed-builtin-skills.ts` : upsert `builtin-playwright-browser` conditionnel
- [ ] `instrumentation.ts` : appel `seedBuiltinSkills()` non-bloquant
- [ ] `npx tsc --noEmit` passe sans erreur
- [ ] `npx jest --passWithNoTests --no-coverage` passe
