---
title: "LO-Phase3 — GET /api/models/available (public endpoint)"
spec: .specs/tasks/todo/llm-overrides-per-agent.feature.md
depends_on: []
created: 2026-04-09
status: todo
round: 1
branch: feat/llm-overrides-per-agent
---

## Objectif

Créer un endpoint read-only accessible par tout utilisateur authentifié
pour lister les profils LLM activés. L'UI du formulaire New Run en a besoin
pour peupler les selects.

Cet endpoint est indépendant de Phase 1 — développable en parallèle.

---

## Fichier à créer

### `app/api/models/available/route.ts`

```ts
// GET /api/models/available
// Public read-only endpoint: returns enabled LLM profiles for run creation UI.
// Requires any valid session (not admin). Does NOT return api_key_enc, config, or secrets.

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { headers } from 'next/headers'
import { db } from '@/lib/db/client'

export async function GET(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const rows = await db.llmProfile.findMany({
    where: { enabled: true },
    select: {
      id: true,
      provider: true,
      model_string: true,
      tier: true,
      context_window: true,
      cost_per_1m_input_tokens: true,
      cost_per_1m_output_tokens: true,
    },
    orderBy: [
      { tier: 'asc' },   // fast, balanced, powerful
      { id: 'asc' },
    ],
  })

  const profiles = rows.map(r => ({
    id:                       r.id,
    provider:                 r.provider,
    model_string:             r.model_string,
    tier:                     r.tier,
    context_window:           r.context_window,
    cost_per_1m_input_tokens:  Number(r.cost_per_1m_input_tokens),
    cost_per_1m_output_tokens: Number(r.cost_per_1m_output_tokens),
  }))

  return NextResponse.json({ profiles })
}
```

---

## Sécurité — surface d'exposition

| Champ | Exposé ? | Raison |
|---|---|---|
| `id` | ✅ | Nécessaire pour construire `llm_overrides` |
| `provider` | ✅ | Contexte UI (icône provider) |
| `model_string` | ✅ | Display name |
| `tier` | ✅ | Groupement UI |
| `context_window` | ✅ | Information technique non sensible |
| `cost_per_*` | ✅ | Indication de coût |
| `config` | ❌ | Contient `api_key_env`, `api_key_enc`, `base_url` |
| `api_key_enc` | ❌ | Clé chiffrée |
| `task_type_affinity` | ❌ | Détail technique inutile pour l'utilisateur |

Le `select` Prisma explicite est la ligne de défense — même si le modèle reçoit
de nouveaux champs sensibles, ils ne seront pas retournés tant qu'on ne les ajoute
pas au `select`.

---

## Points de vigilance

- Pas de cache côté API (pas de revalidate) : les profils peuvent changer en temps réel
  quand l'admin active/désactive un modèle.
- Le `orderBy` trie `tier` alphabétiquement : `balanced < fast < powerful`. C'est
  suffisant pour le groupement côté client, qui regroupe par tier de toute façon.
- `Number(r.cost_per_1m_input_tokens)` : Prisma renvoie des `Decimal` — sérialiser
  avant d'envoyer au client (convention projet).

---

## Tests

Pas de test unitaire nécessaire — c'est un read-only sur la DB, sans logique.
Vérifiable manuellement ou par E2E si la suite existe.

---

## Critère de complétion

- `npx tsc --noEmit` passe
- `GET /api/models/available` retourne les 3 profils activés (haiku, sonnet, opus)
- Aucun champ sensible dans la réponse
- Ajouter au `openapi/v1.yaml` (task Phase 6)
