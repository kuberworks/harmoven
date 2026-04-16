---
title: "LO-Phase1 — Backend: run_config + API route + DB validation"
spec: .specs/tasks/todo/llm-overrides-per-agent.feature.md
depends_on: []
created: 2026-04-09
status: todo
round: 1
branch: feat/llm-overrides-per-agent
---

## Objectif

Accepter `llm_overrides` dans `POST /api/runs`, le valider contre la DB, le stocker
dans `run_config`, et injecter `preferred_llm` dans le metadata du PLANNER.

C'est la task fondatrice — tout le reste en dépend.

---

## Fichiers à modifier

### 1. `lib/execution/run-config.ts`

Ajouter `llm_overrides` au schema Zod :

```ts
export const LlmOverridesSchema = z.object({
  PLANNER:  z.string().max(128).optional(),
  WRITER:   z.string().max(128).optional(),
  REVIEWER: z.string().max(128).optional(),
}).strict()    // .strict() empêche l'injection de clés inconnues (IMAGE_GEN, etc.)

export const RunConfigSchema = z.object({
  // ... champs existants inchangés ...
  llm_overrides: LlmOverridesSchema.optional(),
})
```

Exporter `LlmOverridesSchema` pour réutilisation dans `route.ts`.

### 2. `app/api/runs/route.ts`

**a) Étendre le body Zod (ligne ~66) :**

```ts
import { LlmOverridesSchema } from '@/lib/execution/run-config'

const CreateRunBody = z.object({
  // ... existants ...
  llm_overrides: LlmOverridesSchema.optional(),
}).strict()
```

**b) Validation DB (après auth, avant création du run) :**

```ts
if (body.llm_overrides) {
  const requestedIds = Object.values(body.llm_overrides).filter(Boolean) as string[]
  if (requestedIds.length > 0) {
    const enabled = await db.llmProfile.findMany({
      where: { id: { in: requestedIds }, enabled: true },
      select: { id: true },
    })
    const enabledIds = new Set(enabled.map(p => p.id))
    const invalid = requestedIds.filter(id => !enabledIds.has(id))
    if (invalid.length > 0) {
      return NextResponse.json(
        { error: `Unknown or disabled LLM profile(s): ${invalid.join(', ')}` },
        { status: 422 },
      )
    }
  }
}
```

**c) Stocker dans run_config (ligne ~235) :**

```ts
run_config: {
  providers: [],
  ...(body.enable_web_search ? { enable_web_search: true } : {}),
  ...(body.llm_overrides     ? { llm_overrides: body.llm_overrides } : {}),
},
```

**d) Injecter preferred_llm dans PLANNER metadata (ligne ~273) :**

```ts
{
  ...nodeBase,
  id: uuidv7(), run_id: run.id, node_id: plannerNodeId,
  agent_type: 'PLANNER', status: 'PENDING',
  metadata: {
    task_input: taskInputStr,
    domain_profile: body.domain_profile,
    ...(body.llm_overrides?.PLANNER ? { preferred_llm: body.llm_overrides.PLANNER } : {}),
  },
},
```

---

## Points de vigilance

- Le Zod `.strict()` sur `LlmOverridesSchema` protège contre l'injection de clés
  arbitraires (ex: `{ CLASSIFIER: 'xxx' }` serait rejeté).
- La validation DB utilise `enabled: true` — un profil existant mais désactivé = rejet.
- `Object.values(body.llm_overrides).filter(Boolean)` ignore `undefined` (Auto).
- Aucun changement nécessaire dans `parseRunConfig()` — il fait `safeParse(raw ?? {})`
  et le champ optionnel passe naturellement.

---

## Tests

### `tests/execution/run-config.test.ts` (nouveau)

```ts
describe('RunConfigSchema — llm_overrides', () => {
  it('accepts valid overrides', () => {
    const result = RunConfigSchema.safeParse({
      llm_overrides: { PLANNER: 'claude-opus-4-6', WRITER: 'claude-sonnet-4-6' },
    })
    expect(result.success).toBe(true)
  })

  it('accepts empty overrides', () => {
    const result = RunConfigSchema.safeParse({ llm_overrides: {} })
    expect(result.success).toBe(true)
  })

  it('accepts absent overrides', () => {
    const result = RunConfigSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('rejects unknown agent keys', () => {
    const result = RunConfigSchema.safeParse({
      llm_overrides: { CLASSIFIER: 'claude-haiku-4-5' },
    })
    expect(result.success).toBe(false)
  })

  it('rejects profile IDs exceeding 128 chars', () => {
    const result = RunConfigSchema.safeParse({
      llm_overrides: { PLANNER: 'x'.repeat(129) },
    })
    expect(result.success).toBe(false)
  })
})
```

---

## Critère de complétion

- `npx tsc --noEmit` passe
- Tests unit passent
- Un `POST /api/runs` avec `llm_overrides: { PLANNER: 'claude-opus-4-6' }` crée le run correctement
- Un `POST /api/runs` avec `llm_overrides: { PLANNER: 'nonexistent' }` retourne 422
