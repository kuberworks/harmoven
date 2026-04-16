---
title: "MF-Phase5b — IMAGE_GEN agent + IImageClient (optional)"
spec: .specs/tasks/draft/multi-format-artifact-output.feature.md#part-4
depends_on: [mf-phase1-schema-plumbing, tu-phase1-llm-core-tools]
created: 2026-04-08
status: todo
round: 5
branch: feat/mf-phase5b-image-gen-agent
---

## Objectif

Ajouter le type de nœud `IMAGE_GEN` au DAG. Produit une image binaire (PNG/JPEG/WebP) via
`IImageClient` (OpenAI DALL-E ou Gemini Imagen). Livrable indépendant — peut être mergé
sans bloquer ni être bloqué par les phases 5 et 6.

---

## Prérequis

- `feat/mf-phase1-schema-plumbing` mergé : `LlmProfile.modality` migration disponible
- `feat/tu-phase1-llm-core-tools` mergé : `ILLMClient` stable (pour s'en différencier explicitement)

---

## Spec de référence

- **Part 4 §4.1 à §4.6** — architecture complète IMAGE_GEN
- **Part 2 §2.2** — endpoint `/preview` et miniature inline

---

## Fichiers à créer / modifier

### 1. Migration Prisma

```prisma
// prisma/schema.prisma — sur le modèle LlmProfile, après 'enabled'
modality  String  @default("text")
// Valeurs : "text" | "image" | "multimodal"
```

```bash
npx prisma migrate dev --name add_llmprofile_modality
npx prisma generate
```

### 2. `lib/llm/image-interface.ts` — NOUVEAU

```ts
// Interfaces séparées de ILLMClient (voir spec §4.2 + décision J)
export interface ImageGenOptions {
  model:           string
  width?:          number          // default: 1024
  height?:         number          // default: 1024
  quality?:        'standard' | 'hd'
  style?:          string
  negativePrompt?: string
  signal?:         AbortSignal
}

export interface ImageGenResult {
  bytes:    Buffer
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  model:    string
  costUsd:  number
}

export interface IImageClient {
  generateImage(prompt: string, options: ImageGenOptions): Promise<ImageGenResult>
}
```

### 3. `lib/llm/image-client.ts` — NOUVEAU

`DirectImageClient implements IImageClient` avec :

- **OpenAI / CometAPI :** `client.images.generate({ model, prompt, size: '${w}x${h}', quality, style, response_format: 'b64_json' })` → decoder base64 → Buffer
- **Gemini / Imagen :** `client.models.generateImages({ model, prompt, config: { numberOfImages: 1, aspectRatio: toGeminiAspect(w, h) } })` → `generatedImages[0].image.imageBytes` (base64) → Buffer
- **LiteLLM proxy :** Compatible OpenAI `/images/generations`
- **Ollama :** throw `new Error('Ollama does not support image generation')`

```ts
function selectImageModelFromProfile(profile: LlmProfileConfig): DirectImageClient {
  switch (profile.provider) {
    case 'openai':
    case 'cometapi':  return new DirectImageClient(profile, 'openai')
    case 'google':    return new DirectImageClient(profile, 'gemini')
    case 'litellm':   return new DirectImageClient(profile, 'openai')  // compat
    default:          throw new Error(`Provider ${profile.provider} does not support image generation`)
  }
}
```

### 4. `lib/llm/` — `selectImageModel()`

```ts
// lib/llm/selector.ts (ou lib/llm/image-selector.ts)
export async function selectImageModel(
  ctx?: ChatOptions['selectionContext'],
): Promise<LlmProfileConfig> {
  const profiles = await db.llmProfile.findMany({
    where: { enabled: true, modality: 'image' },
  })
  if (!profiles.length) {
    throw new Error('No image generation model configured')
  }
  // Appliquer les mêmes filtres juridiction/confiance que selectLlm()
  // ... filtrage existant réutilisé ...
  return profiles[0]  // ou tri par coût/qualité
}
```

### 5. `lib/agents/runner.ts`

```ts
// ALLOWED_AGENT_TYPES — ajouter
'IMAGE_GEN',

// case 'IMAGE_GEN' dans le switch — voir spec §4.5 pour le code complet
case 'IMAGE_GEN': {
  const prompt = extractImagePrompt(node.handoff_in)
  if (!prompt) throw new Error('[IMAGE_GEN] No prompt found in handoffIn')

  let imageProfile: LlmProfileConfig
  try {
    imageProfile = await selectImageModel(node.selection_context)
  } catch {
    throw new Error(t('run.node.image_gen.no_provider'))
  }

  const imageClient = new DirectImageClient(imageProfile, imageProfile.provider)
  const result = await imageClient.generateImage(prompt, {
    model:  imageProfile.model_string,
    width:  (node.config as Record<string,number> | null)?.width  ?? 1024,
    height: (node.config as Record<string,number> | null)?.height ?? 1024,
    signal,
  })

  const ext = result.mimeType.split('/')[1] ?? 'png'
  const artifact = await db.runArtifact.create({
    data: {
      run_id:        runId,
      node_id:       node.node_id ?? node.id,
      filename:      buildFilename('image', ext),
      mime_type:     result.mimeType,
      artifact_role: 'primary',
      data:          result.bytes,
      size_bytes:    result.bytes.byteLength,
    },
  })

  await eventBus.emit({
    project_id,
    run_id: runId,
    event: {
      type:           'artifacts_ready',
      node_id:        node.node_id ?? node.id,
      artifact_count: 1,
      filenames:      [artifact.filename],
    },
    emitted_at: new Date(),
  })

  // Mettre à jour Run.primary_artifact_id
  await db.run.update({
    where: { id: runId },
    data:  { primary_artifact_id: artifact.id },
  })

  // Ajouter le coût au total du run
  await db.run.update({
    where: { id: runId },
    data:  {
      total_cost_usd: { increment: result.costUsd },
    },
  })

  return { content: '', metadata: { artifact_id: artifact.id, mime_type: result.mimeType } }
}
```

### 6. `app/api/runs/[runId]/artifacts/[artifactId]/preview/route.ts` — NOUVEAU

```ts
// Endpoint inline image — seul endpoint autorisé à servir Content-Type: image/*
export async function GET(req: Request, { params }: { params: { runId: string; artifactId: string } }) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const artifact = await db.runArtifact.findFirst({
    where: {
      id:            params.artifactId,
      run_id:        params.runId,
      artifact_role: { not: 'discarded' },
    },
  })

  if (!artifact) return NextResponse.json({ error: 'Not Found' }, { status: 404 })

  // Seulement pour les images — protection contre l'utilisation comme XSS bypass
  if (!artifact.mime_type.startsWith('image/')) {
    return NextResponse.json({ error: 'Not an image artifact' }, { status: 404 })
  }

  return new NextResponse(artifact.data, {
    headers: {
      'Content-Type':  artifact.mime_type,
      'Cache-Control': 'private, max-age=3600',
    },
  })
}
```

### 7. `openapi/v1.yaml`

- `IMAGE_GEN` dans la liste des `agent_type` valides sur `Node`
- `LlmProfile` schema : ajouter `modality: { type: string, enum: [text, image, multimodal], default: text }`
- `GET /api/runs/{runId}/artifacts/{artifactId}/preview` : documenter réponse `image/*`

### 8. `locales/en.json` + `locales/fr.json`

```json
"run.node.image_gen.generating": "🖼️ Generating image…",
"run.node.image_gen.failed": "Image generation failed. Please try again.",
"run.node.image_gen.no_provider": "No image generation provider is configured."
```

### 9. Tests

- `tests/llm/image-client.test.ts` : mocker fetch OpenAI images.generate, vérifier Buffer retourné
- `tests/agents/image-gen-runner.test.ts` : case IMAGE_GEN dans runner → artifact créé + SSE émis

---

## Critères de validation

- [ ] `LlmProfile.modality` migration passe sans erreur
- [ ] `IMAGE_GEN` dans `ALLOWED_AGENT_TYPES`
- [ ] Run avec nœud IMAGE_GEN → `RunArtifact` créé avec `mime_type: 'image/png'` et `artifact_role: 'primary'`
- [ ] `Run.primary_artifact_id` set après IMAGE_GEN
- [ ] `GET /api/runs/:id/artifacts/:id/preview` → 200 + `Content-Type: image/png`
- [ ] `GET /api/runs/:id/artifacts/:id/preview` → 404 pour artifact non-image
- [ ] Aucun `image/*` servi depuis l'endpoint principal (toujours `application/octet-stream`)
- [ ] `npx tsc --noEmit` zéro erreur
- [ ] Tests verts

---

## Commit

```
feat(image-gen): IMAGE_GEN agent + IImageClient DALL-E/Imagen + preview endpoint

- prisma/schema.prisma: LlmProfile.modality + migration
- lib/llm/image-interface.ts: IImageClient, ImageGenOptions, ImageGenResult
- lib/llm/image-client.ts: DirectImageClient (OpenAI, Gemini, LiteLLM)
- lib/llm/: selectImageModel() filtered by modality
- lib/agents/runner.ts: IMAGE_GEN case in switch + ALLOWED_AGENT_TYPES
- app/api/runs/[runId]/artifacts/[artifactId]/preview/route.ts: inline image endpoint
- locales/en.json + fr.json: image_gen i18n keys
- openapi/v1.yaml: IMAGE_GEN, modality, /preview
- tests/llm/image-client.test.ts + tests/agents/image-gen-runner.test.ts
```
