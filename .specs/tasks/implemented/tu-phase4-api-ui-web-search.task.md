---
title: "TU-Phase4 — API + UI: enable_web_search toggle + form"
spec: .specs/tasks/draft/llm-tool-use-web-search.feature.md#partie-5
depends_on: [tu-phase3-runner-injection]
created: 2026-04-08
status: todo
round: 4
branch: feat/tu-phase4-api-ui-web-search
---

## Objectif

- Exposer `enable_web_search` dans `POST /api/runs`
- Ajouter le toggle dans le formulaire new run
- Configurer le provider via admin UI (env vars)
- Désormais, le WRITER web-search est entièrement opérationnel end-to-end

---

## Prérequis

`feat/tu-phase3-runner-injection` mergé — le runner sait utiliser `enable_web_search` depuis `run_config`.

---

## Spec de référence

- **Partie 5 §5.1** — `POST /api/runs` body schema
- **Partie 5 §5.2** — toggle form + i18n + data_warning
- **Partie 5 §5.3** — `tool_call_progress` UI rendering dans `NodeCard`
- **Partie 6 §6.1 à §6.2** — admin UI provider config

---

## Fichiers à modifier

### 1. `app/api/runs/route.ts`

Étendre le body Zod schema :
```ts
const CreateRunBody = z.object({
  // ... champs existants inchangés ...
  enable_web_search: z.boolean().optional().default(false),
}).strict()
```

Après la validation Zod, ajouter la validation provider :
```ts
if (parsed.data.enable_web_search) {
  const hasBrave  = !!process.env.BRAVE_SEARCH_API_KEY
  const hasTavily = !!process.env.TAVILY_API_KEY
  // DuckDuckGo toujours disponible — ne pas bloquer
  // mais loguer s'il est le seul disponible
}
// Construire run_config avec enable_web_search
const run_config = {
  ...(existingRunConfig ?? {}),
  ...(parsed.data.enable_web_search ? { enable_web_search: true } : {}),
}
```

### 2. `app/(app)/projects/[projectId]/runs/new/page.tsx`

Ajouter la checkbox dans le formulaire (dans la section "Options avancées" si elle existe, sinon après le textarea de prompt) :

```tsx
<FormField
  control={form.control}
  name="enable_web_search"
  render={({ field }) => (
    <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4">
      <FormControl>
        <Checkbox
          checked={field.value}
          onCheckedChange={field.onChange}
        />
      </FormControl>
      <div className="space-y-1 leading-none">
        <FormLabel>{t('run.web_search.label')}</FormLabel>
        <FormDescription>{t('run.web_search.description')}</FormDescription>
        {field.value && (
          <p className="text-sm text-amber-600 dark:text-amber-400">
            {t('run.web_search.data_warning')}
          </p>
        )}
      </div>
    </FormItem>
  )}
/>
```

Ajouter `enable_web_search: z.boolean().optional().default(false)` au schema Zod du formulaire.
Inclure `enable_web_search: values.enable_web_search` dans le body POST.

### 3. `locales/en.json` + `locales/fr.json`

```json
"run.web_search.label": "🌐 Real-time web search",
"run.web_search.description": "Allows agents to search for current information on the web. May increase run duration and cost.",
"run.web_search.data_warning": "⚠️ Search queries may expose terms from your prompt to the search API (Brave/Tavily). Avoid if your request contains sensitive information."
```

```json
"run.web_search.label": "🌐 Recherche web en temps réel",
"run.web_search.description": "Permet aux agents de rechercher des informations actuelles sur internet. Peut augmenter la durée et le coût du run.",
"run.web_search.data_warning": "⚠️ Les requêtes de recherche peuvent exposer des termes de votre prompt à l'API de recherche (Brave/Tavily). À éviter si votre demande contient des informations confidentielles."
```

### 4. `NodeCard` dans `run-detail-client.tsx`

Consommer `tool_call_progress` SSE pour afficher la progression dans le node WRITER :

```tsx
// Si l'event tool_call_progress est reçu pour ce nodeId
{webSearchProgress && (
  <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1">
    <Globe className="h-3 w-3 animate-pulse" />
    <span>
      {webSearchProgress.query
        ? t('run.node.web_search.searching', { query: webSearchProgress.query })
        : t('run.node.web_search.in_progress')}
    </span>
    {webSearchProgress.result_count != null && (
      <Badge variant="secondary">{webSearchProgress.result_count} {t('run.node.web_search.results')}</Badge>
    )}
  </div>
)}
```

Clés i18n supplémentaires :
```json
"run.node.web_search.searching": "🌐 Searching: \"{query}\"",
"run.node.web_search.in_progress": "🌐 Searching the web…",
"run.node.web_search.results": "results"
```

### 5. `openapi/v1.yaml`

- `CreateRunRequest` schema : ajouter `enable_web_search: { type: boolean, default: false }`
- Note dans la description du champ sur la nécessité de configurer les env vars

---

## Critères de validation

- [ ] `POST /api/runs` avec `enable_web_search: true` → `run_config.enable_web_search = true` en DB
- [ ] `POST /api/runs` avec `enable_web_search: true` et aucune clé API configurée → 400 (ou 200 si DDG disponible)
- [ ] Checkbox cochée dans le formulaire → `data_warning` affiché
- [ ] `NodeCard` affiche la query + nb résultats quand `tool_call_progress` SSE reçu
- [ ] Toutes les strings via `t()`, aucun hardcode
- [ ] `openapi/v1.yaml` mis à jour pour `enable_web_search`
- [ ] `npx tsc --noEmit` zéro erreur

---

## Commit

```
feat(api,ui): enable_web_search toggle in new run form + NodeCard progress

- app/api/runs/route.ts: enable_web_search in CreateRunBody, provider validation
- app/(app)/.../runs/new/page.tsx: web search checkbox + data_warning
- run-detail-client.tsx: tool_call_progress → NodeCard web search progress display
- locales/en.json + fr.json: run.web_search.* + run.node.web_search.* keys
- openapi/v1.yaml: enable_web_search in CreateRunRequest
```
