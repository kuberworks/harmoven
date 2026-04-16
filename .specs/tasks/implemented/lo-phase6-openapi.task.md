---
title: "LO-Phase6 — OpenAPI: document llm_overrides + GET /models/available"
spec: .specs/tasks/todo/llm-overrides-per-agent.feature.md
depends_on: [lo-phase1-backend-api, lo-phase3-models-endpoint]
created: 2026-04-09
status: todo
round: 3
branch: feat/llm-overrides-per-agent
---

## Objectif

Mettre à jour `openapi/v1.yaml` pour documenter les nouveaux endpoints et schémas.
Règle projet : toute modification d'API publique doit être reflétée dans l'OpenAPI.

---

## Modifications dans `openapi/v1.yaml`

### 1. Schema partagé `LlmOverrides`

```yaml
components:
  schemas:
    LlmOverrides:
      type: object
      description: Per-agent LLM profile overrides. Null/absent = auto-select.
      properties:
        PLANNER:
          type: string
          description: LLM profile ID to force for planning agents.
          example: claude-opus-4-6
        WRITER:
          type: string
          description: LLM profile ID to force for writing agents.
          example: claude-sonnet-4-6
        REVIEWER:
          type: string
          description: LLM profile ID to force for reviewing agents.
          example: claude-opus-4-6
      additionalProperties: false
```

### 2. `POST /runs` — body schema extension

Ajouter `llm_overrides` au requestBody schema :

```yaml
llm_overrides:
  $ref: '#/components/schemas/LlmOverrides'
```

Ajouter un exemple dans les examples du requestBody.

### 3. Nouveau path `GET /models/available`

```yaml
/models/available:
  get:
    operationId: listAvailableModels
    summary: List enabled LLM profiles for run creation
    description: |
      Returns all enabled LLM profiles. Used by the run creation UI to populate
      model selection dropdowns. Does not return API keys or provider config.
      Requires any valid user session.
    tags: [Models]
    security:
      - sessionAuth: []
    responses:
      '200':
        description: List of enabled profiles
        content:
          application/json:
            schema:
              type: object
              properties:
                profiles:
                  type: array
                  items:
                    $ref: '#/components/schemas/AvailableProfile'
      '401':
        description: Unauthorized
```

### 4. Schema `AvailableProfile`

```yaml
AvailableProfile:
  type: object
  properties:
    id:
      type: string
      example: claude-sonnet-4-6
    provider:
      type: string
      example: anthropic
    model_string:
      type: string
      example: claude-sonnet-4-6
    tier:
      type: string
      enum: [fast, balanced, powerful]
    context_window:
      type: integer
      example: 200000
    cost_per_1m_input_tokens:
      type: number
      example: 3.00
    cost_per_1m_output_tokens:
      type: number
      example: 15.00
  required: [id, provider, model_string, tier, context_window, cost_per_1m_input_tokens, cost_per_1m_output_tokens]
```

---

## Critère de complétion

- `openapi/v1.yaml` valide (pas de warnings YAML)
- Les 3 ajouts sont présents : LlmOverrides, POST /runs extension, GET /models/available
- Cohérent avec le code implémenté dans Phase 1 et Phase 3
