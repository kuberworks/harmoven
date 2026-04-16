---
title: "LLM Modality Isolation — Type-safe separation of image vs. text models"
status: todo
created: 2026-04-09
depends_on: []
agents_completed: []
agents_pending: [code-explorer, implementer]
---

## Overview

Harden the LLM routing layer so that image-generation models can **never** be
selected for text-agent roles (PLANNER, CLASSIFIER, WRITER, REVIEWER), and add a
`modality` field to `LlmProfileConfig` as the single source of truth for static
type enforcement.

**Scope:** 4 code changes, no Prisma migration, minimal admin UX addition.

---

## Current state

| What exists | Where |
|---|---|
| `modality String @default("text")` | `prisma/schema.prisma` |
| `selectImageModel()` filters `modality='image'` from DB | `lib/llm/selector.ts` |
| `case 'IMAGE_GEN'` in runner | `lib/agents/runner.ts` |
| Draft IMAGE_GEN spec | `.specs/tasks/draft/multi-format-artifact-output.feature.md` |

---

## Gaps to fix

### Gap 0 — `dbRowToLlmProfileConfig` drops `modality` *(blocking)*

`profiles.ts:272` builds `LlmProfileConfig` from a Prisma row but **does not read
`row.modality`**. In production, 100 % of profiles come from DB via this mapper.
Without this fix the interface field exists but is always `undefined` at runtime,
making all selector guards vacuously true (no behavioral effect).

### Gap 1 — `modality` absent from `LlmProfileConfig` interface

`LlmProfileConfig` has no `modality` field, so there is no static type preventing
assignment of an image profile to PLANNER at compile time.

### Gap 2 — `selectByTier()` and `selectLlm()` do not exclude `modality='image'`

Both functions receive all enabled profiles from the caller. An image profile
with `enabled=true` could theoretically be selected for a text agent.

The correct filter is `p.modality !== 'image'` (not `=== 'text'`).
Rationale: `multimodal` models (GPT-4o, Claude 3, Gemini 1.5 Pro) must remain
available for all text-agent roles — blocking them would break real deployments.

### Gap 3 — `llm_overrides` API validation does not check modality

`app/api/runs/route.ts` verifies that an override profile is `enabled`, but not
that it is `modality !== 'image'`. An operator (or API client) could force an
image model onto PLANNER/WRITER and get a runtime failure instead of a clean 422.

### Gap 4 — `LlmProfileRow` and admin page query missing `modality`

`models-client.tsx:22` defines `LlmProfileRow` without a `modality` field. The
admin page `page.tsx` does not select it from Prisma. An enterprise admin enabling
a DALL-E profile sees no visual cue distinguishing it from a Claude profile.
Minimum fix: add the field to the type + query + show a read-only badge in the
model list. Editing modality is out of scope (it is catalog-defined, not
operator-configurable).

---

## Implementation plan

### Phase 1 — Static typing + DB mapper fix

**File:** `lib/llm/profiles.ts`

1. Add to `LlmProfileConfig`:
   ```ts
   modality?: 'text' | 'image' | 'multimodal'
   ```
   Implied default: `'text'` when absent (all existing built-ins are text/chat).

2. In `dbRowToLlmProfileConfig`, add `modality: string` to the `row` parameter
   type and map it:
   ```ts
   modality: (row.modality ?? 'text') as LlmProfileConfig['modality'],
   ```
   This is the prerequisite for all runtime guards — without it Phases 2 and 3
   have no effect in production.

3. `BUILT_IN_PROFILES`: no changes (no image built-ins exist today).

**Also in this phase — admin UI data model:**

4. In `app/(app)/admin/models/models-client.tsx`, add `modality: string` to
   `LlmProfileRow`.

5. In `app/(app)/admin/models/page.tsx`, add `modality: true` to the Prisma
   `select` (data available for Phase 4, not yet displayed).

**Acceptance:** `npx tsc --noEmit` passes. No runtime behavior change.

---

### Phase 2 — Runtime guards in selectors

**File:** `lib/llm/selector.ts`

1. `selectByTier()`: filter the `profiles` input before tier matching:
   ```ts
   const textProfiles = profiles.filter(p => p.modality !== 'image')
   // use textProfiles for all existing logic; return null if empty
   ```

2. `selectLlm()`: add the modality constraint to the `eligible` filter:
   ```ts
   const eligible = candidates.filter(p =>
     p.modality !== 'image'                              &&
     meetsConfidentialityConstraint(p, confidentiality) &&
     meetsJurisdictionConstraint(p, jurisdictionTags)   &&
     meetsContextWindowConstraint(p, node.estimated_tokens),
   )
   ```

3. `selectImageModel()`: **no change** — already filters `modality: 'image'`.

**Failure UX when guard blocks execution:** if `selectLlm` returns `null`
because all candidates are image models, the existing "no eligible model"
escalation path runs → node marked `FAILED`, error visible in run detail UI.
This is acceptable; the Phase 3 API guard prevents reaching this state.

**Acceptance:** Unit tests: pass `multimodal` profile → selected; pass `image`
profile → `null` returned from both `selectByTier` and `selectLlm`.

---

### Phase 3 — API validation of `llm_overrides`

**File:** `app/api/runs/route.ts`

Extend the existing override validation to also reject image-modality profiles.
Keep the "disabled" check and the "image modality" check separate for clear error
messages:

```ts
const validProfiles = await db.llmProfile.findMany({
  where: { id: { in: overrideIds }, enabled: true },
  select: { id: true, modality: true },
})
const validIds   = new Set(validProfiles.map(p => p.id))
const invalid    = overrideIds.filter(id => !validIds.has(id))
const imgInvalid = overrideIds.filter(id =>
  validProfiles.find(p => p.id === id)?.modality === 'image',
)

if (invalid.length > 0) {
  return NextResponse.json(
    { error: `Invalid or disabled LLM profile IDs: ${invalid.join(', ')}` },
    { status: 422 },
  )
}
if (imgInvalid.length > 0) {
  return NextResponse.json(
    {
      error:  'profile_modality_mismatch',
      detail: `Image-generation models cannot be used as agent overrides: ${imgInvalid.join(', ')}`,
    },
    { status: 422 },
  )
}
```

**Acceptance:** `POST /api/runs` with an image profile as WRITER override → 422
`profile_modality_mismatch`. With a multimodal profile → 200 (not blocked).

---

### Phase 4 — Admin UX: modality badge in model list *(non-deferrable)*

**File:** `app/(app)/admin/models/models-client.tsx`

Add a read-only badge in each model row **in the list view** (not only the
edit dialog) showing modality when it is not the default `'text'`:

- `image` → purple badge, label "🖼 Image"
- `multimodal` → blue badge, label "✦ Multimodal"
- `text` (default) → no badge (avoids noise on 95 % of rows)

The badge communicates to a non-technical admin that a DALL-E profile must not
be used as a text-agent override, without requiring them to read documentation.

**Do NOT add a modality edit control** — modality is catalog-defined and should
not be operator-configurable via this form.

i18n keys required (both `locales/en.json` and `locales/fr.json`):
```
admin.models.modality.image        = "Image"
admin.models.modality.multimodal   = "Multimodal"
```

**Acceptance:** Admin models page shows purple "🖼 Image" badge on any
`modality='image'` row. Text-only profiles show no badge.

---

## What is explicitly out of scope

| Item | Reason |
|---|---|
| IMAGE_GEN agent integration | Covered by `multi-format-artifact-output.feature.md` |
| Prisma migration | `modality` column already exists — no schema change needed |
| Editing modality via admin UI | Catalog-defined, not operator-configurable |
| Adding DALL-E / Imagen built-in profiles | Separate seed/catalog task |
| `requiresImageModality` flag on `SelectLlmInput` | Future IMAGE_GEN usage only |

---

## Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | `LlmProfileConfig.modality` typed as `'text' \| 'image' \| 'multimodal' \| undefined` |
| AC-2 | `dbRowToLlmProfileConfig` maps `row.modality`: no profile loaded from DB has `undefined` modality |
| AC-3 | `selectByTier` returns `null` when all profiles have `modality: 'image'` |
| AC-4 | `selectLlm` excludes `modality: 'image'`; `multimodal` profiles are **not** excluded |
| AC-5 | `selectImageModel` is unchanged and still selects only `modality: 'image'` |
| AC-6 | `POST /api/runs` with image-profile override → 422 `profile_modality_mismatch` |
| AC-7 | `POST /api/runs` with multimodal-profile override → 200 (not blocked) |
| AC-8 | Admin models page shows "🖼 Image" badge on `modality='image'` rows |
| AC-9 | `LlmProfileRow` has `modality` field; `page.tsx` Prisma query selects it |
| AC-10 | `npx tsc --noEmit` zero errors; `npx jest --passWithNoTests` all green |
| AC-11 | `openapi/v1.yaml`: document `profile_modality_mismatch` 422 error on `POST /runs` |

---

## Files to modify

| File | Change |
|---|---|
| `lib/llm/profiles.ts` | Add `modality?` to `LlmProfileConfig`; fix `dbRowToLlmProfileConfig` to read `row.modality` |
| `lib/llm/selector.ts` | Filter `modality !== 'image'` in `selectByTier` and `selectLlm` |
| `app/api/runs/route.ts` | Validate modality of `llm_overrides`; return 422 `profile_modality_mismatch` on image profile |
| `app/(app)/admin/models/models-client.tsx` | Add `modality: string` to `LlmProfileRow`; add badge in list |
| `app/(app)/admin/models/page.tsx` | Select `modality` in Prisma query |
| `locales/en.json` + `locales/fr.json` | Add `admin.models.modality.*` i18n keys |
| `openapi/v1.yaml` | Document `profile_modality_mismatch` 422 error |


---

## Critical review of the proposed spec

> (This section is the honest critique requested before implementation. Read it;
> address the objections before marking phases done.)

### ✅ What is correct and well-scoped

- No unnecessary Prisma migration: `modality` column already exists in the DB
  (schema.prisma L538). The gaps are purely TypeScript and runtime guards.
- `selectImageModel()` is already correct and out of scope — right call.
- Ordering (types → runtime guards → API validation) matches the natural
  dependency direction.
- IMAGE_GEN agent and full multi-format-artifact spec remain out of scope — good
  containment.

### ⚠️ Critical gaps the original spec misses or underspecifies

#### G0 — `dbRowToLlmProfileConfig` drops `modality` (silent regression)

The mapper at `profiles.ts:272` builds a `LlmProfileConfig` from a Prisma row but
does **not** read `row.modality`. Even if you add the field to the interface and
the `BUILT_IN_PROFILES` array, any profile loaded from the DB (the production
path, used 100 % of the time) will have `modality: undefined`. The filter
`p.modality !== 'image'` in Phase 2 then silently treats every DB-loaded profile
as non-image — which vacuously passes — so the guard has **no effect at runtime**.
This is the most critical gap. **`dbRowToLlmProfileConfig` must read `row.modality`.**

#### G1 — `selectByTier` receives a pre-filtered pool — guard must be upstream

`selectByTier()` does not build its own candidate pool; it receives the `profiles`
array passed by the caller (`DirectLLMClient`, `ContextualLLMClient`). Adding a
filter inside `selectByTier` is fine, but guards must **also** exist wherever the
`profiles` array is assembled (typically when the executor fetches enabled DB
profiles). Otherwise a caller that bypasses `selectByTier` (e.g. a future agent
type or a test utility) still leaks image-model candidates. The spec gives
no guidance on this.

#### G2 — `multimodal` modality needs an explicit routing rule

The spec defines `modality?: 'text' | 'image' | 'multimodal'` but never says
whether `multimodal` is allowed in text-agent roles. GPT-4o, Claude 3, Gemini
1.5 Pro are `multimodal` — blocking them from PLANNER/WRITER because they are
"not pure text" would break real deployments. The filter must be
`p.modality !== 'image'` (i.e. allow `text` and `multimodal`), not
`p.modality === 'text'`. The spec mentions "or modality === 'text' ||
modality === 'multimodal'" in passing but the final recommendation is ambiguous.
**The spec must commit to the `!== 'image'` form and explain why.**

#### G3 — `LlmProfileRow` (admin UI type) does not include `modality`

The admin models page uses `LlmProfileRow` (`models-client.tsx:22`) which has no
`modality` field. Even if Phase 3 (Gap 4 in the original) is deferred, the Prisma
query in `page.tsx` must at minimum `select: { ..., modality: true }` so the data
is available when the UX phase is eventually added. Without it, adding the UI
column later will require a hidden gap-fill commit. **Add `modality` to
`LlmProfileRow` and the page query now, even if not yet displayed.**

#### G4 — API validation (Phase 3) only checks `llm_overrides` but the run form
         also allows `preferred_llm` injection via PLANNER metadata

`app/api/runs/route.ts:301` injects `preferred_llm: body.llm_overrides.PLANNER`
directly into the PLANNER node metadata. This path is validated. But the same
column can be set by any code path that writes `node.metadata` (e.g. a skill
pack, a future admin endpoint, or a test fixture). The *real* defense should be
in the LLM selector, not only in the one API route. **Phase 2 runtime guard (in
`selectLlm`) is the correct primary defense; the API route check is defense-in-depth.**

#### G5 — No error surfaced to the user when modality guard blocks execution

If at runtime an operator enables an image model, sets it as a WRITER override
(before the API guard exists), and a run starts — what does the user see? Currently
`selectLlm` returns `null` → executor escalates to a HumanGate with a cryptic
"no eligible model" message. After the fix the behavior must be the same or better
(clear error in the run detail UI). The spec says nothing about the failure UX for
the gap 3 scenario (which existed before the API guard was added). **Document the
expected failure path.**

#### G6 — `BUILT_IN_PROFILES` in profiles.ts has no image profiles today

The spec says "add `modality: 'image'` to DALL-E, Imagen… in BUILT_IN_PROFILES
if present". There are **none** present. All built-ins are text/chat models. This
bullet is vacuously true and adds no value. The real work for image profiles is
seeding them into the DB (which needs a migration or seed update). Do not pretend
Phase 1 "adds image profiles" when there are none to add.

#### G7 — UX: "Gap 4 — no modality field in admin UI" is deferred too easily

From an enterprise user perspective, an admin enabling a model from the "Models"
page has no visual cue about what that model is for. A DALL-E 3 row looks exactly
like a Claude row. The admin cannot know which models are safe to set as WRITER
overrides. This is the UX gap that a non-technical enterprise admin will hit in
production.  
The spec defers the admin UI change "via Phase UI in the spec existante" — but
that spec (`multi-format-artifact-output.feature.md`) is a draft with no timeline.
**A minimal UX fix (read-only badge showing modality in the model list) must be
in scope here, not deferred.**

---

## Authoritative implementation plan (revised)

### Phase 1 — Static typing in `LlmProfileConfig` + `dbRowToLlmProfileConfig` fix

**Files:** `lib/llm/profiles.ts`

1. Add `modality?: 'text' | 'image' | 'multimodal'` to `LlmProfileConfig`.
   Default implied: `'text'` when absent.
2. In `dbRowToLlmProfileConfig`, read `row.modality` and map it:
   ```ts
   modality: (row.modality ?? 'text') as LlmProfileConfig['modality'],
   ```
   This requires adding `modality: string` to the `row` parameter type.
   > This is the G0 fix — without it Phases 2 and 3 have no runtime effect.
3. No changes to `BUILT_IN_PROFILES` (no image built-ins exist yet).
4. In `LlmProfileRow` (`models-client.tsx`), add `modality: string` and update
   the Prisma query in `page.tsx` to `select: { ..., modality: true }`.
   (Not displayed yet — data available for Phase UI.)

**Acceptance:** `npx tsc --noEmit` passes. No runtime behavior change.

---

### Phase 2 — Runtime guard in selectors

**Files:** `lib/llm/selector.ts`

1. In `selectByTier()`: filter input `profiles` to exclude `modality === 'image'`
   before the tier match:
   ```ts
   const textProfiles = profiles.filter(p => p.modality !== 'image')
   ```
   Use `textProfiles` for all the existing logic. Return `null` if empty.

2. In `selectLlm()`: add `p.modality !== 'image'` to the `eligible` filter:
   ```ts
   const eligible = candidates.filter(p =>
     p.modality !== 'image'                              &&
     meetsConfidentialityConstraint(p, confidentiality) &&
     meetsJurisdictionConstraint(p, jurisdictionTags)   &&
     meetsContextWindowConstraint(p, node.estimated_tokens),
   )
   ```
   Rationale for `!== 'image'` (not `=== 'text'`): multimodal models (GPT-4o,
   Claude 3, Gemini 1.5 Pro) must remain available for all text-agent roles.

3. `selectImageModel()` — **no change**. It already filters `modality: 'image'`.

**Acceptance:** Jest unit tests: pass `multimodal` profile → selected; pass
`image` profile → `null` returned from `selectByTier` and `selectLlm`.

---

### Phase 3 — API validation of llm_overrides

**File:** `app/api/runs/route.ts`

Extend the existing override validation to also reject image-modality profiles:

```ts
const validProfiles = await db.llmProfile.findMany({
  where: { id: { in: overrideIds }, enabled: true },
  select: { id: true, modality: true },
})
const validIds = new Set(validProfiles.filter(p => p.modality !== 'image').map(p => p.id))
const invalidModality = overrideIds.filter(id =>
  validProfiles.find(p => p.id === id)?.modality === 'image',
)
if (invalidModality.length > 0) {
  return NextResponse.json(
    {
      error: 'profile_modality_mismatch',
      detail: `Image-generation models cannot be used as agent overrides: ${invalidModality.join(', ')}`,
    },
    { status: 422 },
  )
}
```

Note: keep the existing "disabled" check separate from the "image modality" check
so operators get a specific error message for each case.

**Acceptance:** Integration test (or manual curl): POST `/api/runs` with an image
profile as WRITER override → 422 with `error: 'profile_modality_mismatch'`.

---

### Phase 4 — Minimal admin UX: modality badge in model list (G7, non-deferrable)

**File:** `app/(app)/admin/models/models-client.tsx`

Add a small read-only badge in each model row (the table/card list) showing
modality: `text` (default, no badge to avoid noise), `image` (purple badge,
"🖼 Image"), `multimodal` (blue badge, "✦ Multimodal").

Requirements:
- Non-technical admin must immediately know that a model with "🖼 Image" badge
  should not be used as a text-agent override.
- The badge is visible on the model list WITHOUT requiring the edit dialog.
- No edit form change needed (modality is not configurable by the user; it is
  set by the built-in catalog or DB seed — not a free-form admin field).
- i18n keys for `admin.models.modality.image`, `admin.models.modality.multimodal`
  in `locales/en.json` and `locales/fr.json`.

**Acceptance:** Admin page shows purple "🖼 Image" badge on any enabled image
profile. Text profiles show no badge (clean, not cluttered).

---

## What is explicitly out of scope

| Item | Reason |
|---|---|
| IMAGE_GEN agent integration | Covered by `multi-format-artifact-output.feature.md` |
| New Prisma migration | `modality` column exists; no schema change needed |
| Editing modality via admin UI | Modality is catalog-defined, not operator-configurable |
| Adding DALL-E / Imagen built-in profiles | Separate seed/catalog task; no built-ins today |
| `requiresImageModality` flag on `SelectLlmInput` | Future usage only; not needed here |

---

## Failure UX contract (G5 answer)

If at runtime the guard in `selectLlm` returns `null` because all candidates are
image models:
- The executor falls through to its existing "no eligible model" escalation path.
- The node is marked `FAILED` with `error: 'No eligible LLM profile found'`.
- The run detail UI shows the node in red with the error message.
- No silent corruption. This is acceptable behavior; the API Phase 3 guard ensures
  this path should never be reached after the fix is deployed.

---

## Acceptance criteria (full)

| # | Criterion |
|---|---|
| AC-1 | `LlmProfileConfig.modality` typed as `'text' \| 'image' \| 'multimodal' \| undefined` |
| AC-2 | `dbRowToLlmProfileConfig` maps `row.modality` → no image profile ever has `undefined` modality when loaded from DB |
| AC-3 | `selectByTier` returns `null` when all profiles have `modality: 'image'` |
| AC-4 | `selectLlm` excludes `modality: 'image'` profiles; `multimodal` profiles are NOT excluded |
| AC-5 | `selectImageModel` is unchanged and still selects only `modality: 'image'` |
| AC-6 | POST `/api/runs` with image-profile override → 422 `profile_modality_mismatch` |
| AC-7 | POST `/api/runs` with multimodal-profile override → 200 (not blocked) |
| AC-8 | Admin models page shows "🖼 Image" badge on image-modality rows |
| AC-9 | `LlmProfileRow` includes `modality` field; page query selects it |
| AC-10 | `npx tsc --noEmit` zero errors; `npx jest --passWithNoTests` all green |
| AC-11 | `openapi/v1.yaml`: document `profile_modality_mismatch` 422 error on POST `/runs` |

---

## Files to modify

| File | Change |
|---|---|
| `lib/llm/profiles.ts` | Add `modality?` to `LlmProfileConfig`; fix `dbRowToLlmProfileConfig` to read `row.modality` |
| `lib/llm/selector.ts` | Filter `modality !== 'image'` in `selectByTier` and `selectLlm` |
| `app/api/runs/route.ts` | Validate modality in llm_overrides; return 422 on image profile |
| `app/(app)/admin/models/models-client.tsx` | Add `modality: string` to `LlmProfileRow`; add badge in list |
| `app/(app)/admin/models/page.tsx` | Select `modality` in Prisma query |
| `locales/en.json` + `locales/fr.json` | Add `admin.models.modality.*` i18n keys |
| `openapi/v1.yaml` | Document `profile_modality_mismatch` error |
