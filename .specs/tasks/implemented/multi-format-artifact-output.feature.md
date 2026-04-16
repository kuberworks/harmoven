---
title: "Multi-format artifact output + web search — generate anything, download everything"
depends_on: []
created: 2026-04-08
revised: 2026-04-08
status: draft
agents_completed: [architect-review, peer-review, ux-review]
agents_pending: [implementer]
---

# Multi-format artifact output + web search opt-in

## Context & Problem Statement

Harmoven's agents produce two categories of output:

| Path | Who | How | Download |
|---|---|---|---|
| Markdown text | WRITER → REVIEWER | `handoff_out.output.content` | None (rendered inline only) |
| Binary artifacts | PYTHON_EXECUTOR | Python `files[]` → `RunArtifact.data` | ✅ download link |
| HTML artifact | WRITER (detected by REVIEWER via `detectArtifactFormat()`) | runner.ts | ✅ download link |

**Gaps — artifact output:**
1. User asking for a Word report, CSV, or a code file gets nothing downloadable.
2. `detectArtifactFormat()` only handles HTML — all other text-based formats stranded in `handoff_out`.
3. No concept of "the primary artifact" — the main deliverable — distinct from intermediate files.
4. Result tab shows artifacts only if PYTHON_EXECUTOR ran, buried below node cards — invisible to non-technical users.
5. WRITER has no structured output mode: when asked to produce CSV or JSON, it may wrap the content in markdown prose and fence blocks → corrupt files.

**Gaps — web search:**
6. LLM agents have no access to live information. Tasks requiring current data ("latest pricing", "recent API changes", "today's news") produce stale or fabricated content.
7. No `WEB_SEARCH` node type, no search provider wiring, no UI toggle.

---

## Target Architecture

### Principles

> **Separation of concerns:** WRITER produces *content*; a post-processor produces the *file*. These are independent and testable separately.

> **Structured contract per format:** WRITER must know when its output will become a file. For structured formats (CSV, JSON, code), it writes raw structured content only — zero prose, zero Markdown fences. The format mode is injected into the system prompt.

> **WEB_SEARCH as a first-class DAG node** (not LLM tool_use): the PLANNER adds `WEB_SEARCH` nodes at the start of the DAG when the run_config opt-in flag is set. Results flow through handoff. No changes needed to `ILLMClient`, no tool-calling loop, zero risk to existing agent execution.

> **Non-technical UX first:** a user who has never heard of "RunArtifact" or "handoff" must immediately understand that their file is ready. Every error, every progress message, every button must use plain language.

```
User prompt → CLASSIFIER (detects desired_outputs[]) → PLANNER
                                                          │
               ┌──────────────────────────────────────────┤
               │  if enable_web_search = true             │
               ▼                                          ▼
         WEB_SEARCH nodes                        WRITER nodes
         (search results in handoff_out)    (text content ± output_file_format)
               │                                          │
               └──────────────┬───────────────────────────┘
                              ▼
                       PYTHON_EXECUTOR (computation-driven binaries)
                              │
                              ▼
                       REVIEWER (approves → sets primary_artifact_id)
                              │
                              ▼
                   RunArtifact (status: primary | supplementary | discarded)
                              │
                              ▼
              "Your [Word report / CSV / script] is ready" ← Result Tab UI
```

---

## Audit — Code existant (8 avril 2026)

### Ce qui est déjà implémenté et conforme

**Pattern ChatGPT/Claude déjà en place dans `ResultTab`** (`run-detail-client.tsx`) :

```
[Card] Contenu Markdown rendu via ReactMarkdown + rehype-sanitize   ← le "message"
[Card] "Generated files" — liste de <a href download>               ← les "artifacts"
       └── "Download all (.zip)" via /api/runs/:runId/artifacts/zip
```

- API `GET /api/runs/:runId/artifacts` : ne retourne **que des métadonnées** (pas le binaire). Le binaire n'est chargé que sur clic via `/artifacts/:id`. Conforme au modèle ChatGPT.
- ZIP batch déjà disponible — ChatGPT et Claude n'ont pas cette fonctionnalité. Avantage Harmoven.
- `ResultTab` re-fetch les artifacts à chaque fois qu'un node passe COMPLETED (`completedCount` comme trigger).

### 3 lacunes bloquantes identifiées

**Lacune 1 — `artifact_role` absent du type `ArtifactMeta` et du SELECT API**

`ArtifactMeta` dans `run-detail-client.tsx` n'a pas de champ `artifact_role`. Le `GET /api/runs/:runId/artifacts` ne le retourne pas non plus (SELECT explicite). Conséquence : la `ResultTab` **ne peut pas filtrer par rôle** — elle afficherait des artifacts `pending_review` ou `discarded`. Correction dans Phase 5 + Phase 6 ci-dessous.

**Lacune 2 — Polling au lieu de SSE push**

`ResultTab` utilise `completedCount` (recompte des nodes COMPLETED) pour déclencher un re-fetch. Cela signifie qu'un artifact WRITER créé après la complétion du node WRITER déclenchera le fetch au bon moment, mais sans push ciblé : si plusieurs nodes se complètent rapidement, des fetches inutiles s'accumulent.

Solution : émettre un event SSE `artifact_ready` depuis l'executor immédiatement après `db.runArtifact.create()`. `ResultTab` écoute cet event et re-fetch de façon ciblée. Le polling `completedCount` devient un **fallback de sécurité** (pas supprimé).

**Lacune 3 — Le WRITER ne crée pas encore de `RunArtifact`**

Le commentaire dans `NodeCard` dit explicitement `// Artifact download state (PYTHON_EXECUTOR nodes only)`. La logique `convertWriterOutput()` → `db.runArtifact.create()` n'existe pas — c'est la Phase 2 du présent spec.

### Tableau comparatif

| Aspect | ChatGPT/Claude | Harmoven actuel | Après spec |
|---|---|---|---|
| Métadonnées séparées des binaires | ✓ | ✓ | ✓ |
| Download via `<a href download>` | ✓ | ✓ | ✓ |
| ZIP batch | ✗ | ✓ | ✓ |
| Artifact notifié via stream | ✓ SSE/WS | ✗ polling | ✓ SSE push |
| Filtrage par rôle (primary) | N/A | ✗ | ✓ |
| WRITER produce un fichier | ✓ | ✗ | ✓ |

---

## Part 1 — Multi-format Artifact Output

### 1.1 CLASSIFIER — detect `desired_outputs`

**New field on `ClassifierResult`:**

```ts
export interface ClassifierResult {
  // ... existing fields ...
  desired_outputs?: DesiredOutput[]    // NEW — inferred from user intent
}

export interface DesiredOutput {
  format: OutputFileFormat             // "docx" | "csv" | "py" | ...
  description: string                  // "le rapport Word final"
  produced_by: 'writer' | 'python'    // routing hint for PLANNER
}
```

The CLASSIFIER system prompt is extended with output-detection rules:

```
DESIRED OUTPUT DETECTION:
- "Word document / rapport Word / .docx / fichier Word" → { format: "docx", produced_by: "writer" }
- "CSV / tableur / export CSV" → { format: "csv", produced_by: "writer" }
- "Python script / code Python" → { format: "py", produced_by: "writer" }
- "Excel with formulas / calculs / tableau de bord" → { format: "xlsx", produced_by: "python" }
- "PDF" → { format: "pdf", produced_by: "writer" }
- "JSON / YAML config" → { format: "json" | "yaml", produced_by: "writer" }
- (no explicit format requested) → omit desired_outputs entirely
```

The PLANNER receives `desired_outputs` through the handoff chain (via `ClassifierHandoff`) and uses it to set `output_file_format` on WRITER nodes. **The PLANNER never invents format — it consumes`desired_outputs` from CLASSIFIER.** This eliminates the hallucination risk.

### 1.2 WRITER — structured output mode

**Problem from peer review:** WRITER produces markdown. When `output_file_format` is `"csv"`, the LLM wraps the CSV in a prose introduction and a ` ```csv ``` ` fence. The converter receives corrupted input.

**Fix:** When `output_file_format` is a structured format, the WRITER system prompt switches to **structured-only mode**:

```ts
// lib/agents/writer.ts — new content_mode injection
function buildWriterSystemPrompt(meta: WriterNodeMeta): string {
  if (meta.output_file_format && STRUCTURED_FORMATS.has(meta.output_file_format)) {
    return WRITER_STRUCTURED_PROMPT[meta.output_file_format]
    // Returns a prompt that says:
    //   "Output ONLY [raw CSV rows | JSON object | Python code | ...].
    //    No prose, no markdown fences, no explanations.
    //    Your entire response is the file content."
  }
  if (meta.output_file_format === 'docx' || meta.output_file_format === 'pdf') {
    return WRITER_DOCUMENT_PROMPT
    // Standard markdown prompt — converter handles the markdown → binary step
  }
  return WRITER_DEFAULT_PROMPT  // existing behaviour
}

const STRUCTURED_FORMATS = new Set(['csv', 'json', 'yaml', 'py', 'ts', 'js', 'sh', 'sql'])
```

The structured prompt per format is explicit:

| Format | WRITER instruction |
|---|---|
| `csv` | "Output ONLY raw CSV. First row = headers. Use comma separator, UTF-8, no BOM. No explanation." |
| `json` | "Output ONLY a valid JSON object or array. No prose, no code fences." |
| `yaml` | "Output ONLY valid YAML. No prose, no code fences." |
| `py` / `ts` / `js` / `sh` / `sql` | "Output ONLY raw source code. No prose, no markdown fences. Comments inside the code are allowed." |
| `docx` / `pdf` | Standard markdown mode (converter transforms markdown → binary) |

### 1.3 `OutputFileFormat` type

```ts
// lib/agents/planner.ts
export type OutputFileFormat =
  | 'txt' | 'csv' | 'json' | 'yaml' | 'html'
  | 'py' | 'ts' | 'js' | 'sh' | 'sql'
  | 'docx' | 'pdf'
  // Note: 'xlsx' and 'zip' are NOT here — xlsx is always PYTHON_EXECUTOR via openpyxl;
  //        zip is handled by the existing /artifacts/zip endpoint, not a format field.
```

`output_file_format` is absent / `undefined` = existing behaviour, no artifact created.

### 1.4 `RunArtifact` — 3-state `artifact_role`

**From peer review:** 2 states is ambiguous when REVIEWER requests revision.

```prisma
model RunArtifact {
  id            String   @id @default(uuid())
  run_id        String
  node_id       String
  run           Run      @relation(fields: [run_id], references: [id], onDelete: Cascade)
  filename      String
  mime_type     String
  size_bytes    Int
  data          Bytes
  artifact_role String   @default("pending_review")
  // "pending_review" — created, awaiting REVIEWER verdict
  // "primary"        — approved by REVIEWER (APPROVE verdict)
  // "discarded"      — superseded (REJECT, REQUEST_REVISION, or run FAILED)
  created_at    DateTime @default(now())
  expires_at    DateTime
}
```

Lifecycle:
1. Converter creates → `artifact_role: "pending_review"`
2. REVIEWER APPROVE → UPDATE to `"primary"` → sets `Run.primary_artifact_id`
3. REVIEWER REQUEST_REVISION / REJECT → UPDATE to `"discarded"`
4. Run FAILED → UPDATE all `pending_review` for run to `"discarded"` (cleanup job)

**API consumers must never show `discarded` or `pending_review` artifacts in the Result tab** — only `primary` and `supplementary`.

### 1.5 `Run` — add `primary_artifact_id`

```prisma
model Run {
  // ... existing fields ...
  primary_artifact_id  String?  // NOT a FK — artifact may expire before run
}
```

### 1.6 Unified artifact creation — remove `detectArtifactFormat()`

**From peer review:** 3 artifact creation paths creates inconsistent `artifact_role` logic.

**Phase 2 removes `detectArtifactFormat()` entirely.** HTML is now handled via `output_file_format: "html"` — same path as all other formats. The CLASSIFIER's `desired_outputs` detection includes HTML:

```
"HTML page / webpage / HTML report" → { format: "html", produced_by: "writer" }
```

After this change, there are exactly **2** artifact creation paths:
1. **WRITER + `output_file_format`** → `convertWriterOutput()` → `RunArtifact { artifact_role: "pending_review" }`
2. **PYTHON_EXECUTOR `files[]`** → existing runner path → `RunArtifact { artifact_role: "supplementary" }` (Python-produced files are never "primary" — they are always supporting artifacts)

### 1.7 Runner — `convertWriterOutput()` + validation

**Location:** `lib/execution/converters/text-to-file.ts`

```ts
// runner.ts — inside WRITER case, after writerOutput is returned
if (writerMeta.output_file_format) {
  const result = await convertWriterOutput(writerOutput, writerMeta.output_file_format, {
    run_id: node.run_id,
    node_id: node.node_id,
    description: node.description,
    db,
  })
  if (!result.valid) {
    // Store error in Node.metadata → SSE error event → node fails with human-readable message
    throw new Error(`Le fichier ${writerMeta.output_file_format.toUpperCase()} n'a pas pu être généré : ${result.error}`)
  }
}
```

**`convertWriterOutput` pipeline:**

```
raw LLM text content
      │
      ▼
  sanitize(content, format)       // strip any accidental markdown fences
      │
      ▼
  encode(content, format)         // Buffer.from(content, 'utf-8') or marked→docx/pdf
      │
      ▼
  validateArtifact(buffer, format) // magic bytes, JSON.parse, CSV column check
      │
  ┌───┴─────┐
  │ invalid │ → throw (triggers node FAILED + human-readable error SSE)
  └───┬─────┘
      │ valid
      ▼
  db.runArtifact.create({
    run_id, node_id, filename, mime_type, size_bytes,
    data: buffer,
    artifact_role: 'pending_review',
    expires_at: addDays(now(), 90),
  })
```

**`validateArtifact()` per format:**

```ts
function validateArtifact(format: OutputFileFormat, data: Buffer): ValidationResult {
  switch (format) {
    case 'json':  JSON.parse(data.toString('utf-8')); return { valid: true }
    case 'csv':   validateCsvColumns(data); return { valid: true }   // check uniform column count
    case 'docx':  
    case 'xlsx':  // magic bytes: PK\x03\x04 (ZIP-based Office formats)
                  if (data[0] !== 0x50 || data[1] !== 0x4B) throw new Error('invalid OOXML')
                  return { valid: true }
    default:      return { valid: true }  // txt, md, code: always valid
  }
}
```

**Filename convention:** `<description_slug>.<ext>` — human-readable, not UUID-based. E.g. `rapport-ventes-q1.docx`, `analyse-utilisateurs.csv`. The slug is derived from `node.description` (max 48 chars, kebab-case, ASCII-safe).

### 1.8 REVIEWER → transition `artifact_role`

```ts
// lib/execution/custom/executor.ts — after REVIEWER node COMPLETED
if (reviewerVerdict === 'APPROVE') {
  // Promote pending_review → primary (at most one)
  const pending = await db.runArtifact.findFirst({
    where: { run_id, node_id: reviewedNodeId, artifact_role: 'pending_review' }
  })
  if (pending) {
    await db.runArtifact.update({ where: { id: pending.id }, data: { artifact_role: 'primary' } })
    await db.run.update({ where: { id: run_id }, data: { primary_artifact_id: pending.id } })
  }
} else {
  // Discard all pending artifacts for this run
  await db.runArtifact.updateMany({
    where: { run_id, artifact_role: 'pending_review' },
    data: { artifact_role: 'discarded' },
  })
}
```

### 1.8a Cas limites — runs sans REVIEWER ou PYTHON_EXECUTOR sans REVIEWER

**[C3] PYTHON_EXECUTOR sans REVIEWER — artifacts `supplementary` :**
Les artifacts de PYTHON_EXECUTOR sont créés directement avec `artifact_role: 'supplementary'` (jamais `pending_review`). Ils ne passent pas par la transition REVIEWER. Le banner Result tab s'affiche aussi pour les artifacts `supplementary` — la condition d'affichage est `runArtifacts.length > 0`, pas `primary_artifact_id`. Comportement intentionnel : les fichiers Python sont des livrables techniques, pas des documents primaires.

**[C4] Run WRITER sans REVIEWER — auto-transition vers `primary` :**
Si un run atteint `COMPLETED` sans nœud REVIEWER dans le DAG, tout artifact `pending_review` doit être promu automatiquement :

```ts
// lib/execution/custom/executor.ts — dans la logique onRunCompleted
const hasReviewerNode = dag.nodes.some(n => n.agent_type === 'REVIEWER')
if (!hasReviewerNode) {
  await db.runArtifact.updateMany({
    where: { run_id, artifact_role: 'pending_review' },
    data:  { artifact_role: 'primary' },
  })
  const promoted = await db.runArtifact.findFirst({
    where:   { run_id, artifact_role: 'primary' },
    orderBy: { created_at: 'asc' },
  })
  if (promoted) {
    await db.run.update({ where: { id: run_id }, data: { primary_artifact_id: promoted.id } })
  }
}
```

Sans ce mécanisme, le banner "votre document est prêt" ne s'afficherait jamais pour les pipelines simples (CLASSIFIER → PLANNER → WRITER — le cas d'usage le plus fréquent).

### 1.9 Converter implementations

**Phase A — Zero-dependency (text as bytes)**

| Format | MIME | Sanitizer |
|---|---|---|
| `txt` | `text/plain; charset=utf-8` | none |
| `csv` | `text/csv; charset=utf-8` | strip leading markdown fences |
| `json` | `application/json` | strip fences, validate with `JSON.parse` |
| `yaml` | `text/yaml` | strip fences |
| `html` | `text/html; charset=utf-8` | strip markdown fences |
| `py` / `ts` / `js` / `sh` / `sql` | `text/plain; charset=utf-8` | strip fences |

**Phase B — Binary converters (new npm deps)**

| Format | Bibliothèque | Notes |
|---|---|---|
| `docx` | **`remark-docx`** (v0.3.26, MIT) | `unified().use(remarkParse).use(remarkDocx, { output: 'buffer' }).process(md)` → `ArrayBuffer`. Supporte : headings, listes, tableaux, code blocks (syntax highlight via shiki), blockquotes, inline styles, footnotes, images. TypeScript natif, activement maintenu (dernière release < 1 mois). |
| `pdf` | **`remark-pdf`** (même auteur, companion) | Même pipeline remark. Deferred to Phase B-2. Alternative côté client : le bouton Print existant dans `ResultTab` génère déjà un PDF de qualité via `window.print()`. |

**Pourquoi pas `docx` (npm) directement ?** La bibliothèque `docx` construit le document manuellement (chaque `Paragraph`, `TextRun`, `TableRow` est explicite). Mapper un AST Markdown complet représente 3–5 semaines de travail. `remark-docx` encapsule `docx` avec un mapper AST complet — l'implémentation se réduit à :

```typescript
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkDocx from 'remark-docx'

export async function markdownToDocx(markdown: string): Promise<Buffer> {
  const processor = unified().use(remarkParse).use(remarkDocx, { output: 'buffer' })
  const file = await processor.process(markdown)
  return Buffer.from(file.result as ArrayBuffer)
}
```

**Size cap:** All converters enforce `MAX_ARTIFACT_SIZE_BYTES = 10 * 1024 * 1024` (10 MB). Exceeding → throw with human-readable message.

---

## Part 2 — Artifact SSE push + Web Search cross-reference

### 2.1 Décision d'architecture — recherche web (8 avril 2026)

**La recherche web est implémentée via LLM tool_use natif dans `ILLMClient`**, pas comme nœud DAG. L'approche initiale `WEB_SEARCH as-DAG-node` est **supersédée** par `llm-tool-use-web-search.feature.md`.

| Critère | DAG node (approche initiale) | tool_use (approche finale) |
|---|---|---|
| Qualité des queries | ✗ PLANNER écrit les queries à l'avance | ✓ LLM décide dynamiquement pendant la rédaction |
| Code providers | ✗ Dupliqué dans ce spec | ✓ Un seul `lib/agents/tools/web-search.ts` |
| Visibilité DAG | ✓ Nœuds explicites | Tool calls dans `Node.metadata.tool_calls_trace` |
| Changements ILLMClient | ✓ Aucun | Minimal — 2 champs optionnels backward-compat |

**Ce spec délègue entièrement à `llm-tool-use-web-search.feature.md` pour :**
- `RunConfig.enable_web_search` + `parseRunConfig()` → spec §4.1
- Providers Brave/Tavily/DuckDuckGo → `lib/agents/tools/web-search.ts` (spec §3.3)
- Toggle UI formulaire new run → spec §5.2
- SSE `tool_call_progress` → spec §5.3
- Sources citées dans la réponse finale → spec §5.2

**Supprimé de ce spec :** `WebSearchAgent` (DAG node), enum `WEB_SEARCH` dans `agent_type`, `web_search_progress` SSE event (renommé `tool_call_progress` dans le spec tool_use).

### 2.2 SSE `artifact_ready` event

**Distinction de nommage :** L'event `artifacts_ready` (pluriel) existe déjà dans `types/events.ts` pour PYTHON_EXECUTOR — batch, une seule émission après N fichiers. L'event `artifact_ready` (singulier, nouveau) est émis **une fois par fichier**, immédiatement après `db.runArtifact.create()`, et transporte `artifact_role` + `mime_type` pour que l'UI puisse réagir de façon différenciée (ex : afficher une miniature inline pour les images). Les deux coexistent dans le discriminated union `RunSSEEvent`.

```ts
// types/events.ts — à ajouter au discriminated union RunSSEEvent
| {
    type: 'artifact_ready'
    artifact_id: string
    filename: string
    mime_type: string
    node_id: string
    artifact_role: 'pending_review' | 'primary' | 'supplementary'
  }
```

**Emission** depuis `lib/execution/custom/executor.ts` immédiatement après `db.runArtifact.create()` :

```ts
bus.publish(runId, {
  type: 'artifact_ready',
  artifact_id: artifact.id,
  filename:    artifact.filename,
  mime_type:   artifact.mime_type,
  node_id,
  artifact_role: artifact.artifact_role,
})
```

**Consommation** dans `ResultTab` (`run-detail-client.tsx`) :

```ts
case 'artifact_ready':
  if (ev.artifact_role !== 'discarded') {
    fetch(`/api/runs/${runId}/artifacts`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((all: ArtifactMeta[]) =>
        setRunArtifacts(all.filter(a => a.artifact_role !== 'discarded')))
      .catch(() => {})
  }
  break
```

**Images — affichage inline :** si `ev.mime_type.startsWith('image/')`, la `ResultTab` affiche une miniature inline en plus du bouton télécharger :

```tsx
// run-detail-client.tsx — dans la liste des artifacts
{artifact.mime_type.startsWith('image/') ? (
  <img
    src={`/api/runs/${runId}/artifacts/${artifact.artifact_id}/preview`}
    alt={artifact.filename}
    className="max-h-48 rounded-md object-contain"
  />
) : (
  <FileIcon mime={artifact.mime_type} />
)}
```

**Endpoint `/preview`** — `GET /api/runs/:runId/artifacts/:id/preview` (nouveau) :
- Sert le contenu avec `Content-Type: image/*` (valeur réelle du `mime_type` stocké)
- 404 si `mime_type` n'est pas `image/*` ou si l'artifact est `discarded`
- `Cache-Control: private, max-age=3600`
- L'endpoint principal `GET /artifacts/:id` continue à forcer `Content-Disposition: attachment` sans exception (S1)

**IMAGE_GEN nodes — silence UX :** pendant l'exécution, le `NodeCard` n'a pas de `partial_output`. L'UI affiche un skeleton animé avec le label `t('run.node.image_gen.generating')` (`"🖼 Génération de l'image en cours…"`) entre `state_change(RUNNING)` et `artifacts_ready`. Dès que `artifacts_ready` arrive, la miniature inline s'affiche et le skeleton disparaît.

Le polling `completedCount` existant est conservé comme **fallback de sécurité** (SSE perdu, reconnexion tardive).

---

## Part 3 — Non-Technical UX

### 3.1 Run creation form — plain language for format output

**Current:** User must know to write "generate a Word document" to trigger format detection.

**Enhancement:** The new run form adds an optional "Format de sortie" selector:

```
[ ] Générer un fichier téléchargeable
    [Select format ▼]
    • Document Word (.docx)
    • Tableur CSV (.csv)
    • Fichier JSON (.json)
    • Script Python (.py)
    • Page HTML (.html)
    • Laisser les agents décider

Caption: "Vous pourrez toujours télécharger le résultat au format Markdown."
```

When a format is pre-selected, it is passed as `preferred_output_format` in the `task_input` metadata and injected into the CLASSIFIER context, which propagates to PLANNER via `desired_outputs`. The user doesn't need to phrase the format in their prompt.

**Priorité [C2] :** le format sélectionné dans ce selector est **autoritaire**. La détection `desired_outputs` du CLASSIFIER n'est utilisée que si le selector est sur "Laisser les agents décider" (valeur `undefined`). Les deux signaux ne coexistent jamais en conflit — le form-selector court-circuite le CLASSIFIER.

### 3.2 Result tab — "Your file is ready" banner

**Current:** Artifacts are shown in a generic list without context.

**New design (non-technical user first):**

```
┌──────────────────────────────────────────────────────────────────────┐
│  ✅ Terminé — votre document est prêt                                │
│                                                                      │
│  📄  rapport-ventes-q1.docx                    [⬇ Télécharger]       │
│      Document Word • 142 Ko • généré le 8 avr. 2026 à 14:32         │
│                                                                      │
│  ──────────────────────────────────────────────────────────────────  │
│  Fichiers générés (3)                                                │
│  ├ 📄 rapport-ventes-q1.docx   142 Ko  [⬇]                          │
│  ├ 📊 données-brutes.csv        38 Ko  [⬇]                          │
│  └ 📊 sales.xlsx                87 Ko  [⬇]                          │
│                                                                      │
│  [⬇ Tout télécharger (.zip)]                                         │
└──────────────────────────────────────────────────────────────────────┘
```

Rules:
- "votre document est prêt" → when `primary_artifact_id` is set
- "votre script est prêt" → when primary artifact is a code file
- "votre tableur est prêt" → when primary artifact is `.csv`
- "votre analyse est prête" → when no artifact (markdown result only)
- File type icons by extension: 📄 docx/pdf/txt, 📊 csv/xlsx, `{ }` json, `</>` html, `⚙️` py/js/ts/sh
- Expiration notice: "⏱ Disponible pour 90 jours" below the file list

### 3.3 Human-readable errors

When `convertWriterOutput()` throws:
```
"Le fichier CSV n'a pas pu être généré : les colonnes ne sont pas uniformes (ligne 3 a 4 colonnes, ligne 1 en a 5). Essayez de relancer le run."
```

When web search fails:
```
"La recherche web est temporairement indisponible. Les agents ont continué avec leurs connaissances intégrées."
```

When artifact is too large:
```
"Le fichier généré dépasse la taille maximale (10 Mo). Essayez de réduire la portée de votre demande."
```

All error messages are added to `locales/en.json` and `locales/fr.json` with `t()` keys.

### 3.4 Progress — streaming labels for non-technical users

SSE `state_change` events for `WEB_SEARCH` nodes display:
- `RUNNING`: "🌐 Recherche sur le web en cours…"
- `COMPLETED`: "🌐 5 résultats trouvés"
- `FAILED`: "🌐 Recherche indisponible — continuation sans données en temps réel"

WRITER node with `output_file_format` set:
- `COMPLETED`: "📄 Document Word en cours de génération…" (shown briefly while converter runs)
- After RunArtifact created: "📄 Votre document est prêt"

---

## Part 4 — IMAGE_GEN Agent

### 4.1 Vue d'ensemble

`IMAGE_GEN` est un nouveau type de nœud DAG qui produit une image binaire (PNG, JPEG, WebP) à partir d'un prompt texte. Il s'insère après PLANNER dans le DAG, se comporte comme WRITER (prend un handoffIn, produit un `RunArtifact`), mais utilise **`IImageClient`** (non `ILLMClient`) et ne génère pas de contenu texte.

**Cas d'usage typique :**
```
CLASSIFIER → PLANNER → IMAGE_GEN (visuel) + WRITER (légende)
                     → REVIEWER (optionnel)
```

### 4.2 Interface `IImageClient`

```ts
// lib/llm/image-interface.ts — interface séparée de ILLMClient
// Motif : les API image n'ont pas de contexte messages, pas de token counting,
// sortie binaire, coût fixe par image — ILLMClient est incompatible (voir aussi
// llm-tool-use-web-search.feature.md décision J).

export interface ImageGenOptions {
  model:            string
  width?:           number          // default: 1024
  height?:          number          // default: 1024
  quality?:         'standard' | 'hd'
  style?:           string          // ex: "vivid" | "natural" (DALL-E) | "RAW" (Imagen)
  negativePrompt?:  string
  signal?:          AbortSignal
}

export interface ImageGenResult {
  bytes:     Buffer
  mimeType:  'image/png' | 'image/jpeg' | 'image/webp'
  model:     string
  costUsd:   number   // coût fixe par image, pas par token
}

export interface IImageClient {
  generateImage(prompt: string, options: ImageGenOptions): Promise<ImageGenResult>
}
```

### 4.3 `LlmProfile.modality`

Nouveau champ sur `LlmProfile` (migration requise) :
```prisma
modality  String  @default("text")  // "text" | "image" | "multimodal"
```

La fonction `selectImageModel(selectionContext)` filtre `modality = 'image'` et respecte les mêmes critères de juridiction/confiance que `selectLlm()`. Elle throw si aucun profil image n'est activé → le node échoue avec message non technique `t('run.node.image_gen.no_provider')`.

### 4.4 Implémentations providers

| Provider | Modality | API call | Notes |
|---|---|---|---|
| OpenAI / CometAPI | `image` | `client.images.generate({ model: 'dall-e-3', prompt, size, quality, style })` | Réponse `b64_json` |
| Gemini / Imagen | `image` | `client.models.generateImages({ model: 'imagen-3.0-generate-002', prompt, config: { numberOfImages: 1, aspectRatio } })` | Réponse `generatedImages[0].image.imageBytes` (base64) |
| LiteLLM proxy | `image` | Compatible syntaxe OpenAI `/images/generations` | Pass-through vers le provider configuré |
| Ollama | n/a | **Non supporté** — Ollama ne supporte pas la génération d'images via API | — |

### 4.5 Cas dans `runner.ts`

```ts
// lib/agents/runner.ts
const ALLOWED_AGENT_TYPES = new Set([
  'CLASSIFIER', 'PLANNER', 'WRITER', 'REVIEWER',
  'SMOKE_TEST', 'REPAIR', 'CRITICAL_REVIEW', 'PYTHON_EXECUTOR',
  'IMAGE_GEN',  // NEW
])

// case 'IMAGE_GEN' dans le switch :
case 'IMAGE_GEN': {
  // 1. Extraire le prompt depuis handoffIn (PLANNER output)
  const prompt = extractImagePrompt(node.handoff_in)
  if (!prompt) throw new Error('[IMAGE_GEN] No prompt found in handoffIn')

  // 2. Sélectionner un profil image activé (modality = 'image')
  const imageProfile = await selectImageModel(node.selection_context)

  // 3. Instancier DirectImageClient et générer
  const imageClient = new DirectImageClient(imageProfile)
  const result = await imageClient.generateImage(prompt, {
    model:  imageProfile.model_string,
    width:  node.config?.width  ?? 1024,
    height: node.config?.height ?? 1024,
  })

  // 4. Persister en RunArtifact (artifact_role: 'primary' directement — pas de REVIEWER automatique)
  const artifact = await db.runArtifact.create({
    data: {
      run_id:        runId,
      node_id:       node.node_id,
      filename:      buildFilename('image', result.mimeType.split('/')[1]),
      mime_type:     result.mimeType,
      artifact_role: 'primary',
      data:          result.bytes,
      size_bytes:    result.bytes.byteLength,
    },
  })

  // 5. Émettre SSE artifacts_ready (event existant — pas de nouvel event)
  await bus.emit({ project_id, run_id: runId, event: {
    type:           'artifacts_ready',
    node_id:        node.node_id,
    artifact_count: 1,
    filenames:      [artifact.filename],
  }, emitted_at: new Date() })

  // 6. handoff_out : pas de texte, juste les métadonnées
  return { content: '', metadata: { artifact_id: artifact.id, mime_type: result.mimeType, cost_usd: result.costUsd } }
}
```

**Note coût :** `ImageGenResult.costUsd` est un coût fixe par image (ex : DALL-E 3 HD = $0.080). L'executor l'ajoute au total `Run.total_cost_usd` comme pour un appel LLM.

### 4.6 UX spécifique IMAGE_GEN

| Étape | Événement SSE | Comportement UI |
|---|---|---|
| Node passe RUNNING | `state_change(node, RUNNING)` | `NodeCard` : skeleton animé + `t('run.node.image_gen.generating')` ("🖼️ Génération de l'image en cours…") — pas de `partial_output` |
| Génération terminée | `artifacts_ready(node_id, 1, [filename])` | `ResultTab` : miniature inline `<img src="…/preview">` + bouton télécharger ; `NodeCard` : skeleton remplacé par la miniature |
| Node COMPLETED | `state_change(node, COMPLETED)` | Badge vert sur `NodeCard` |
| Échec (quota, no provider) | `state_change(node, FAILED)` + `error(msg)` | Message non technique `t('run.node.image_gen.failed')` |

---

## Data Model Changes (consolidated)

### Schema migration

```sql
-- Migration: add_artifact_role_web_search_primary
ALTER TABLE "RunArtifact"
  ADD COLUMN "artifact_role" TEXT NOT NULL DEFAULT 'pending_review';

ALTER TABLE "Run"
  ADD COLUMN "primary_artifact_id" TEXT;

-- Phase 5b migration (IMAGE_GEN — séparée, peut être déployée indépendamment)
ALTER TABLE "LlmProfile"
  ADD COLUMN "modality" TEXT NOT NULL DEFAULT 'text';
  -- Valeurs valides : 'text' | 'image' | 'multimodal'
```

No data backfill needed. All existing `RunArtifact` rows will have `artifact_role = 'pending_review'`, which is harmless — they were created by PYTHON_EXECUTOR runs where no REVIEWER set them to `primary`. The API filter (show only `primary` + `supplementary`) simply means existing artifacts remain as-is; the PYTHON_EXECUTOR path is updated in Phase 2 to create with `artifact_role: 'supplementary'` directly.

**Note:** `SourceTrustEvent` model already has `source_type: 'web_search'` — no migration needed for web search logging.

---

## API Changes

**`POST /api/runs`** — add `enable_web_search: z.boolean().optional()` to body schema.

**`GET /api/runs/:runId`** — include `primary_artifact_id` in response.

**`GET /api/runs/:runId/artifacts`** — include `artifact_role` in each item; filter out `discarded` items by default (add `?include_discarded=true` query param for admin use). Exact change: add `artifact_role: true` to Prisma `select`, add `artifact_role: { not: 'discarded' }` to `where`.

**`GET /api/runs/:runId/artifacts/:id/preview`** — NEW (Phase 5b) — sert le contenu avec `Content-Type: image/*` inline pour les artifacts image uniquement. 404 si `mime_type` non-image ou artifact `discarded`. `Cache-Control: private, max-age=3600`. Utilisé par `ResultTab` pour la miniature inline (voir §2.2).

---

## OpenAPI Changes (`openapi/v1.yaml`)

- `RunArtifactMeta` schema: add `artifact_role: { type: string, enum: [primary, supplementary, pending_review, discarded] }`
- `Run` schema: add `primary_artifact_id: { type: string, nullable: true }`
- `CreateRunRequest` schema: add `enable_web_search: { type: boolean, default: false }`
- Document `IMAGE_GEN` as a valid `agent_type` on `Node`
- `LlmProfile` schema: add `modality: { type: string, enum: [text, image, multimodal], default: text }`
- `GET /api/runs/:runId/artifacts/:id/preview` : document response as `image/*`

---

## Security Hardening

### S1 — Artifacts HTML servis sans `Content-Disposition` [P0]

**Problème :** `GET /api/runs/:runId/artifacts/:id` sert les artifacts avec leur `mime_type` stocké. Un artifact `text/html` est exécuté par le navigateur si ouvert dans un onglet → XSS.

**Correction dans `app/api/runs/[runId]/artifacts/[artifactId]/route.ts` :**

```ts
// Forcer attachment pour TOUS les artifacts, sans exception
return new NextResponse(artifact.data, {
  headers: {
    'Content-Disposition':    `attachment; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`,
    'Content-Type':           'application/octet-stream',  // ignore le mime_type stocké
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control':          'private, no-store',
  },
})
```

Le `mime_type` stocké sert uniquement aux icônes et labels UI, jamais au header HTTP.

**Exception : endpoint `/preview`** — Seul `GET /api/runs/:runId/artifacts/:id/preview` est autorisé à servir `Content-Type: image/*` pour l'affichage inline. Protégé par une validation `mime_type.startsWith('image/')` + `artifact_role: { not: 'discarded' }`. L'endpoint de téléchargement principal garde `Content-Type: application/octet-stream` sans exception.

### S2 — CSV formula injection [P1]

Les fichiers CSV ouverts dans Excel/LibreOffice exécutent les cellules commençant par `= + - @`. Ajouter dans `lib/execution/converters/sanitize.ts` :

```ts
function sanitizeCsvCell(cell: string): string {
  return /^[=+\-@]/.test(cell)
    ? `'${cell}`   // prefix guillemet simple — standard anti-injection
    : cell
}

// Appelé dans la phase sanitize du converter csv, avant validateArtifact()
export function sanitizeCsvFormulas(csv: string): string {
  return csv.split('\n')
    .map(row => row.split(',')
      .map(cell => sanitizeCsvCell(cell.trim()))
      .join(','))
    .join('\n')
}
```

### S3 — Artifacts `discarded` accessibles via endpoint individuel [P1]

`GET /api/runs/:runId/artifacts/:id` doit bloquer les artifacts `discarded` :

```ts
const artifact = await db.runArtifact.findFirst({
  where: {
    id:            artifactId,
    run_id:        runId,
    artifact_role: { not: 'discarded' },
  },
})
if (!artifact) return NextResponse.json({ error: 'Not Found' }, { status: 404 })
```

Note : les artifacts `pending_review` restent accessibles (le REVIEWER doit pouvoir les télécharger).

### S4 — Filename injection dans `Content-Disposition` [P2]

```ts
// lib/execution/converters/text-to-file.ts
function toSlug(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^a-z0-9\u00e0-\u024f]+/gi, '-')
    .replace(/(^-+|-+$)/g, '')
    .slice(0, 48)
    || 'output'
}

// Enregistré en DB comme filename — le header HTTP utilise encodeURIComponent() (voir S1)
export function buildFilename(slug: string, ext: string): string {
  return `${slug}.${ext}`.replace(/[\r\n"\\]/g, '_')
}
```

---

## Implementation Phases

### Phase 1 — Schema + type plumbing (no behaviour change)
- `prisma/schema.prisma`: `RunArtifact.artifact_role`, `Run.primary_artifact_id`
- Run `npx prisma migrate dev --name add_artifact_role_primary_artifact_id`
- `lib/agents/planner.ts` + `lib/agents/handoff.ts`: `output_file_format` on `PlannerNode` (optional Zod field); `DesiredOutput` on ClassifierResult
- `lib/execution/run-config.ts`: typed `RunConfig` interface (voir aussi `llm-tool-use-web-search.feature.md` §4.1 pour le contenu complet)
- `openapi/v1.yaml`: document all new fields
- No behaviour change — zero risk

### Phase 2 — Converters + structured WRITER mode (Phase A formats)
- `lib/execution/converters/text-to-file.ts`: Phase A converters (txt, csv, json, yaml, html, code)
- `lib/execution/converters/validate.ts`: `validateArtifact()` function
- `lib/execution/converters/sanitize.ts`: strip accidental markdown fences from structured output
- `lib/agents/writer.ts`: `buildWriterSystemPrompt()` with structured-only mode per format
- `runner.ts`: post-WRITER hook calling `convertWriterOutput()` when `output_file_format` set
- **Remove `detectArtifactFormat()` from `runner.ts`** — HTML now goes through the same path
- `runner.ts`: PYTHON_EXECUTOR path creates artifacts with `artifact_role: 'supplementary'` explicitly
- Unit tests: `tests/execution/converters/`

### Phase 3 — CLASSIFIER + PLANNER (format inference)
- `lib/agents/classifier.ts`: add `desired_outputs` detection to system prompt + `ClassifierResult` type
- `lib/agents/planner.ts`: consume `desired_outputs` from handoff; set `output_file_format` on WRITER nodes
- `lib/agents/handoff.ts`: add `desired_outputs` to `PlannerNodeSchema`
- Integration tests: classifier → desired_outputs, planner → DAG with `output_file_format`
- Note : les règles de routing web search pour le PLANNER sont dans `llm-tool-use-web-search.feature.md` §4.2

### Phase 4 — Security hardening (voir § Security Hardening ci-dessus)
- `app/api/runs/[runId]/artifacts/[artifactId]/route.ts`: `Content-Disposition: attachment`, `Content-Type: application/octet-stream`, `X-Content-Type-Options: nosniff` (S1)
- `lib/execution/converters/sanitize.ts`: `sanitizeCsvFormulas()` (S2) + `buildFilename()` (S4)
- `app/api/runs/[runId]/artifacts/[artifactId]/route.ts`: filter `artifact_role: { not: 'discarded' }` (S3)
- Tests : `tests/execution/converters/sanitize.test.ts` + `tests/api/artifact-security.test.ts`

### Phase 5 — REVIEWER → artifact role promotion
- `lib/execution/custom/executor.ts`: après REVIEWER COMPLETE + APPROVE → promouvoir `pending_review` → `primary`, set `Run.primary_artifact_id`; sur REJECT/REQUEST_REVISION → discard
- `lib/execution/custom/executor.ts`: ajouter l'émission SSE `artifact_ready` après **chaque** `db.runArtifact.create()` (WRITER converter et PYTHON_EXECUTOR)
- `app/api/runs/[runId]/artifacts/route.ts`:
  - Ajouter `artifact_role: true` au `select` Prisma
  - Filtrer `discarded` par défaut : `where: { run_id: runId, artifact_role: { not: 'discarded' } }`
  - Ajouter `?include_discarded=true` query param pour admin
- `app/api/runs/[runId]/route.ts` (GET): inclure `primary_artifact_id` dans la réponse

### Phase 5b — IMAGE_GEN agent (optionnel, livrable indépendamment)
- `prisma/schema.prisma`: `LlmProfile.modality String @default("text")`
- `npx prisma migrate dev --name add_llmprofile_modality`
- `npx prisma generate`
- NEW `lib/llm/image-interface.ts`: `IImageClient`, `ImageGenOptions`, `ImageGenResult` (voir §4.2)
- NEW `lib/llm/image-client.ts`: `DirectImageClient` — OpenAI/DALL-E, Gemini/Imagen, LiteLLM (voir §4.4)
- `lib/llm/`: `selectImageModel()` — filtre `modality = 'image'`, même logique juridiction/confiance que `selectLlm()`
- `lib/agents/runner.ts`: ajouter `'IMAGE_GEN'` à `ALLOWED_AGENT_TYPES` + case `IMAGE_GEN` dans le switch (voir §4.5)
- NEW `app/api/runs/[runId]/artifacts/[artifactId]/preview/route.ts`: endpoint inline image (voir `§2.2` + S1)
- `run-detail-client.tsx`: skeleton `NodeCard` pour IMAGE_GEN + miniature inline dans `ResultTab` (voir §4.6)
- `locales/en.json` + `locales/fr.json`: `run.node.image_gen.generating`, `run.node.image_gen.failed`, `run.node.image_gen.no_provider`
- `openapi/v1.yaml`: `IMAGE_GEN` agent_type, `modality` sur LlmProfile, `/preview` endpoint
- Tests: `tests/llm/image-client.test.ts`, `tests/agents/image-gen-runner.test.ts`

### Phase 6 — UI (non-technical UX)
- `app/(app)/projects/[projectId]/runs/new/page.tsx`: format selector (voir §3.1) + toggle web search (implémenté dans `llm-tool-use-web-search.feature.md` §5.2)
- `app/(app)/projects/[projectId]/runs/[runId]/run-detail-client.tsx`:
  - `ArtifactMeta` type : ajouter `artifact_role: 'pending_review' | 'primary' | 'supplementary' | 'discarded'`
  - `ResultTab` : écouter event SSE `artifact_ready` → re-fetch ciblé (voir §2.2)
  - `ResultTab` : filtrer `artifact_role !== 'discarded'` sur la liste affichée
  - `ResultTab` : remplacer le label hardcodé `"Generated files"` par `t('run.result.artifacts.title')`
  - `ResultTab` : "Your file is ready" banner basé sur `runArtifacts.find(a => a.artifact_role === 'primary') ?? runArtifacts[0]`
  - `NodeCard` : le commentaire `// PYTHON_EXECUTOR nodes only` doit être retiré
  - `NodeCard` : filtrer `a.artifact_role !== 'discarded'` dans la liste per-node
- `types/events.ts` : ajouter `artifact_ready` (voir §2.2)
- `locales/en.json` + `locales/fr.json` : toutes les nouvelles clés erreur/statut i18n

### Phase 7 — Phase B converters (docx, pdf)
- `npm install remark-docx remark-parse unified`
- `lib/execution/converters/to-docx.ts`: `markdownToDocx()` via `remark-docx` (10 MB cap, pas de worker_threads nécessaire — remark-docx est non-bloquant)
- `npm install remark-pdf` (Phase B-2, déféré)
- `lib/execution/converters/to-pdf.ts`: `markdownToPdf()` via `remark-pdf`
- Unit tests for both

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| WRITER hallucinated format in structured mode | Structured prompt is explicit ("output ONLY raw CSV"); sanitizer strips fences before convert; CSV validator catches column mismatch → node ERROR with retry |
| PLANNER invents `output_file_format` without CLASSIFIER signal | Zod schema on `PlannerNode`: `output_file_format` is a strict enum; PLANNER prompt rule "only set `output_file_format` if `desired_outputs` contains it" |
| `artifact_role: "pending_review"` artifacts visibles dans l'UI | API `GET /artifacts` filtre `pending_review` et `discarded` par défaut; endpoint individuel bloque `discarded` (S3) |
| Artifact HTML exécuté dans le navigateur | `Content-Disposition: attachment` + `Content-Type: application/octet-stream` forcé sur tous les artifacts (S1) |
| Formula injection dans CSV | `sanitizeCsvFormulas()` prefix guillemet simple sur les cellules `= + - @` (S2) |
| `remark-docx` conversion lente | Mesures : <100ms pour 10 pages. Pas de worker_threads nécessaire. Timeout 30s comme garde-fou. |
| Artifact DB growth | `expires_at` est déjà sur `RunArtifact` (90 days). Add cron job to DELETE WHERE expires_at < NOW() |
| `discarded` artifacts accumulate | UPDATE all `pending_review` → `discarded` dans cleanup job quand le run atteint un état terminal |
| Provider image indisponible / quota dépassé | `selectImageModel()` throw → node FAILED + `t('run.node.image_gen.no_provider')` ; message non technique, pas de stack trace |
| `/preview` endpoint sert du contenu non-image | Validation `mime_type.startsWith('image/')` avant de servir → 404 sinon ; jamais d'exécution HTML via `/preview` |

---

## Acceptance Criteria

**Artifact output:**
- [ ] User writes "génère un rapport Word" → run downloads as `.docx` from Result tab, opens correctly in Microsoft Word
- [ ] User writes "export CSV" → `.csv` with uniform columns, UTF-8, no markdown artefacts, cells starting with `=` are prefixed with `'`
- [ ] User writes "Python script" → `.py` file with pure source code, no prose wrappers
- [ ] User pre-selects "Document Word" in form → same result without mentioning format in prompt; form format takes priority over CLASSIFIER detection
- [ ] PYTHON_EXECUTOR run → artifacts are `supplementary`, banner shows in Result tab
- [ ] `detectArtifactFormat()` no longer exists in `runner.ts`
- [ ] Run WRITER without REVIEWER → artifact auto-promoted to `primary` on run COMPLETED
- [ ] `Run.primary_artifact_id` set after REVIEWER APPROVE
- [ ] REVIEWER REQUEST_REVISION → artifact is `discarded`, not visible in UI
- [ ] `GET /api/runs/:runId/artifacts` never returns `discarded` items by default

**Security:**
- [ ] `GET /api/runs/:runId/artifacts/:id` → always uses `Content-Disposition: attachment` and `Content-Type: application/octet-stream`, regardless of stored mime_type
- [ ] HTML artifact downloaded (not rendered) in browser — no XSS possible
- [ ] CSV artifact cells starting with `=`, `+`, `-`, `@` are prefixed with `'`
- [ ] `GET /api/runs/:runId/artifacts/:id` returns 404 for `discarded` artifacts
- [ ] Filename in `Content-Disposition` uses `encodeURIComponent`; no CRLF injection possible

**UX:**
- [ ] Result tab shows "Votre document est prêt" (or equivalent) when `primary_artifact_id` is set
- [ ] File type icons displayed per extension
- [ ] Expiry date displayed on artifact list
- [ ] All error messages use keys from `locales/en.json` + `locales/fr.json`
- [ ] `npx tsc --noEmit` passes with zero errors
- [ ] All existing Jest tests pass
- [ ] `openapi/v1.yaml` updated for all new fields/endpoints

**IMAGE_GEN:**
- [ ] `IMAGE_GEN` node in a DAG → `RunArtifact` with `mime_type: 'image/png'` and `artifact_role: 'primary'` created
- [ ] `ResultTab` affiche une miniature inline `<img>` pour les artifacts image
- [ ] `GET /api/runs/:runId/artifacts/:id/preview` → 200 + `Content-Type: image/png` pour artifact image
- [ ] `GET /api/runs/:runId/artifacts/:id/preview` → 404 pour artifact non-image
- [ ] `GET /api/runs/:runId/artifacts/:id/preview` → 404 pour artifact `discarded`
- [ ] `LlmProfile.modality = 'image'` — seuls les profils image sont sélectionnés par `selectImageModel()`
- [ ] NodeCard affiche skeleton + `t('run.node.image_gen.generating')` pendant RUNNING (pas de partial_output)
- [ ] Skeleton disparaît et miniature apparaît dès `artifacts_ready` SSE reçu

---

## Test Plan

### Unit
- `tests/execution/converters/text-to-file.test.ts` — Phase A: CSV column uniform check, JSON validity, HTML fence strip, code fence strip
- `tests/execution/converters/validate.test.ts` — invalid CSV (unequal columns), invalid JSON, valid docx magic bytes
- `tests/execution/converters/sanitize.test.ts` — CSV formula injection strip (`=CMD()` → `'=CMD()`), filename CRLF sanitisation
- `tests/execution/converters/to-docx.test.ts` — markdown with headings/bold/lists → docx buffer, magic bytes check (PK\x03\x04)
- `tests/api/artifact-security.test.ts` — GET artifact always returns `Content-Disposition: attachment`; `discarded` artifact → 404

### Integration
- `tests/agents/classifier-desired-outputs.test.ts` — "make me a Word report" → CLASSIFIER returns `desired_outputs: [{ format: "docx", produced_by: "writer" }]`
- `tests/agents/planner-format-routing.test.ts` — PLANNER + `desired_outputs: [csv]` → DAG has WRITER node with `output_file_format: "csv"`
- `tests/execution/runner-artifact-lifecycle.test.ts` — WRITER node → `pending_review`; REVIEWER APPROVE → `primary`; REVIEWER REJECT → `discarded`; run without REVIEWER → auto-promoted to `primary`

### E2E (manual for now)
- Full run: "Analyse X, donne-moi un rapport Word" → `rapport-x.docx` visible in Result tab, opens in Word
- Full run: avec web search activé, "tarif actuel de Claude Opus" → WEB_SEARCH node runs, WRITER cites sources
- Full run: web search provider down → run completes with warning, no failure
