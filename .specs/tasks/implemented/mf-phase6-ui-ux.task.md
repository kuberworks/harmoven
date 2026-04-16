---
title: "MF-Phase6 — UI: ResultTab SSE, format selector, non-technical UX"
spec: .specs/tasks/draft/multi-format-artifact-output.feature.md#part-3
depends_on: [mf-phase1-schema-plumbing, mf-phase2-converters-writer, mf-phase5-reviewer-artifact-role]
created: 2026-04-08
status: todo
round: 4
branch: feat/mf-phase6-ui-ux
---

## Objectif

- `ResultTab` écoute SSE `artifact_ready` (re-fetch ciblé, pas de polling) + affiche miniatures inline pour les images
- `ResultTab` banner "votre document est prêt" basé sur `primary_artifact_id`
- Format selector dans le formulaire new run
- Toutes les strings UI via `t()` — ajout dans `locales/en.json` + `locales/fr.json`

---

## Prérequis

- `feat/mf-phase1-schema-plumbing` mergé : champs Prisma disponibles
- `feat/mf-phase2-converters-writer` mergé : artifacts créés avec rôles corrects
- `feat/mf-phase5-reviewer-artifact-role` mergé : `artifact_ready` SSE event + API expose `artifact_role`

---

## Spec de référence

- **Part 2 §2.2** — consommation SSE `artifact_ready` + affichage inline images
- **Part 3 §3.1** — format selector
- **Part 3 §3.2** — banner "votre document est prêt"
- **Part 3 §3.3** — messages d'erreur non techniques
- **Part 3 §3.4** — labels de progression
- **Phase 6** du spec

---

## Fichiers à modifier

### 1. `app/(app)/projects/[projectId]/runs/[runId]/run-detail-client.tsx`

#### 1a — Type `ArtifactMeta`
```ts
type ArtifactMeta = {
  id:            string
  filename:      string
  mime_type:     string
  size_bytes:    number
  created_at:    string   // ISO
  expires_at:    string | null
  artifact_role: 'pending_review' | 'primary' | 'supplementary' | 'discarded'
  node_id:       string | null
}
```

#### 1b — SSE `artifact_ready` dans le hook stream

Dans le `switch(event.type)` du consommateur SSE (`useRunStream` ou inline `EventSource`) :
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

case 'tool_call_progress':
  // Afficher dans NodeCard section de progression
  setNodeProgress(ev.node_id, {
    type:    'web_search',
    query:   ev.query,
    results: ev.result_count,
    iter:    ev.iteration,
  })
  break
```

Le polling `completedCount` existant est **conservé** comme fallback de sécurité — ne pas supprimer.

#### 1c — Filtrer l'affichage pour exclure `discarded`
```ts
// Dans ResultTab — remplacer l'affichage existant
const visibleArtifacts = runArtifacts.filter(a => a.artifact_role !== 'discarded')
```

#### 1d — Banner "votre document est prêt"

Afficher en tête de `ResultTab` si `run.primary_artifact_id` est set (et run COMPLETED) :
```tsx
{run.primary_artifact_id && run.status === 'COMPLETED' && (
  <Alert variant="success" className="mb-4">
    <CheckCircle className="h-4 w-4" />
    <AlertTitle>{getPrimaryBannerTitle(primaryArtifact)}</AlertTitle>
    <AlertDescription className="mt-2 flex items-center gap-2">
      <FileIcon mime={primaryArtifact.mime_type} />
      <span className="font-medium">{primaryArtifact.filename}</span>
      <span className="text-muted-foreground">
        {formatFileSize(primaryArtifact.size_bytes)}
      </span>
      <Button asChild size="sm" className="ml-auto">
        <a href={`/api/runs/${runId}/artifacts/${primaryArtifact.id}`} download>
          {t('run.result.download')}
        </a>
      </Button>
    </AlertDescription>
  </Alert>
)}
```

`getPrimaryBannerTitle(artifact)` :
- `.docx / .pdf / .txt` → `t('run.result.banner.document')`
- `.csv / .xlsx` → `t('run.result.banner.spreadsheet')`
- `.py / .js / .ts / .sh` → `t('run.result.banner.script')`
- default → `t('run.result.banner.file')`

#### 1e — Miniature inline pour images

Dans la liste des artifacts :
```tsx
{artifact.mime_type.startsWith('image/') ? (
  <img
    src={`/api/runs/${runId}/artifacts/${artifact.id}/preview`}
    alt={artifact.filename}
    className="max-h-48 rounded-md object-contain border"
  />
) : (
  <FileIcon mime={artifact.mime_type} />
)}
```

#### 1f — Retirer le commentaire `// PYTHON_EXECUTOR nodes only` dans `NodeCard`

#### 1g — Expiry label
```tsx
{artifact.expires_at && (
  <span className="text-xs text-muted-foreground">
    {t('run.result.artifact.expires', { date: formatDate(artifact.expires_at) })}
  </span>
)}
```

### 2. `app/(app)/projects/[projectId]/runs/new/page.tsx`

Ajouter le format selector dans le formulaire (section "Options avancées" ou après la textarea) :

```tsx
<FormField
  control={form.control}
  name="output_file_format"
  render={({ field }) => (
    <FormItem>
      <FormLabel>{t('run.form.output_format.label')}</FormLabel>
      <Select onValueChange={field.onChange} defaultValue={field.value}>
        <FormControl>
          <SelectTrigger>
            <SelectValue placeholder={t('run.form.output_format.placeholder')} />
          </SelectTrigger>
        </FormControl>
        <SelectContent>
          <SelectItem value="">{t('run.form.output_format.auto')}</SelectItem>
          <SelectItem value="docx">📄 Document Word (.docx)</SelectItem>
          <SelectItem value="csv">📊 {t('run.form.output_format.csv')}</SelectItem>
          <SelectItem value="json">{ } {t('run.form.output_format.json')}</SelectItem>
          <SelectItem value="py">⚙️ {t('run.form.output_format.python')}</SelectItem>
          <SelectItem value="html">&lt;/&gt; {t('run.form.output_format.html')}</SelectItem>
        </SelectContent>
      </Select>
      <FormDescription>{t('run.form.output_format.description')}</FormDescription>
    </FormItem>
  )}
/>
```

Inclure `output_file_format` dans le body envoyé à `POST /api/runs`.

### 3. `locales/en.json` + `locales/fr.json`

Ajouter les clés suivantes (voir spec §3.2 + §3.3 + §3.4) :
```json
"run.result.banner.document": "✅ Done — your document is ready",
"run.result.banner.spreadsheet": "✅ Done — your spreadsheet is ready",
"run.result.banner.script": "✅ Done — your script is ready",
"run.result.banner.file": "✅ Done — your file is ready",
"run.result.download": "Download",
"run.result.artifacts.title": "Generated files",
"run.result.artifact.expires": "Available for {date}",
"run.form.output_format.label": "Output format",
"run.form.output_format.placeholder": "Let agents decide",
"run.form.output_format.auto": "Let agents decide",
"run.form.output_format.csv": "CSV spreadsheet",
"run.form.output_format.json": "JSON data",
"run.form.output_format.python": "Python script",
"run.form.output_format.html": "HTML page",
"run.form.output_format.description": "You can always download the result as Markdown.",
"run.error.converter.csv_columns": "The CSV file could not be generated: columns are not uniform. Try re-running.",
"run.error.converter.too_large": "The generated file exceeds the 10 MB limit. Try reducing the scope of your request.",
"run.node.image_gen.generating": "🖼️ Generating image…",
"run.node.image_gen.failed": "Image generation failed. Please try again.",
"run.node.image_gen.no_provider": "No image generation provider is configured."
```

Ajouter les équivalents français dans `locales/fr.json`.

---

## Critères de validation

- [ ] `ResultTab` : SSE `artifact_ready` déclenche un re-fetch ciblé (pas de polling complet)
- [ ] Artifact `discarded` non visible dans la liste
- [ ] Banner "votre document est prêt" visible quand `primary_artifact_id` set + run COMPLETED
- [ ] Miniature `<img>` affichée pour artifacts `image/*`
- [ ] Format selector dans le formulaire new run
- [ ] `output_file_format` sélectionné dans le form → envoyé dans `POST /api/runs`
- [ ] Label hardcodé `"Generated files"` remplacé par `t('run.result.artifacts.title')`
- [ ] Aucune string anglaise hardcodée dans les composants modifiés
- [ ] `npx tsc --noEmit` passe zéro erreur

---

## Commit

```
feat(ui): ResultTab SSE artifact_ready + primary banner + format selector

- run-detail-client.tsx: ArtifactMeta with artifact_role, SSE artifact_ready handler,
  tool_call_progress handler, discard filter, primary banner, image inline preview,
  expiry label, remove PYTHON_EXECUTOR comment
- app/(app)/.../runs/new/page.tsx: output_file_format selector
- locales/en.json + fr.json: all new i18n keys (banner, format selector, errors)
```
