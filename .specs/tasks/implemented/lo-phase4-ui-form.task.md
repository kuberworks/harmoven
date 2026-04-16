---
title: "LO-Phase4 — UI: New Run form with model presets + custom selects"
spec: .specs/tasks/todo/llm-overrides-per-agent.feature.md
depends_on: [lo-phase1-backend-api, lo-phase3-models-endpoint]
created: 2026-04-09
status: todo
round: 3
branch: feat/llm-overrides-per-agent
---

## Objectif

Ajouter une section "Model selection" au formulaire de création de run.
Fermée par défaut, elle expose d'abord des presets (Auto < Economy < Standard < Power)
puis un mode Custom avec un select par agent type.

**Principe UX** : un utilisateur d'entreprise ne devrait jamais DEVOIR ouvrir cette section.
C'est un power-user opt-in.

---

## Fichiers à modifier

### 1. `app/(app)/projects/[projectId]/runs/new/page.tsx`

**Nouveaux états :**

```ts
type QualityPreset = 'auto' | 'economy' | 'standard' | 'power' | 'custom'

const [llmPreset, setLlmPreset]       = useState<QualityPreset>('auto')
const [customOverrides, setCustomOverrides] = useState<Record<string, string>>({})
const [availableProfiles, setAvailableProfiles] = useState<AvailableProfile[] | null>(null)
const [llmSectionOpen, setLlmSectionOpen] = useState(false)
```

**Fetch des profils :**

```ts
useEffect(() => {
  fetch('/api/models/available')
    .then(r => r.ok ? r.json() : null)
    .then((data: { profiles: AvailableProfile[] } | null) => {
      if (data?.profiles) setAvailableProfiles(data.profiles)
    })
    .catch(() => { /* non-blocking */ })
}, [])
```

**Calcul des overrides à envoyer :**

```ts
function computeLlmOverrides(): Record<string, string> | undefined {
  if (llmPreset === 'auto' || !availableProfiles) return undefined

  if (llmPreset === 'custom') {
    const overrides: Record<string, string> = {}
    for (const [agent, profileId] of Object.entries(customOverrides)) {
      if (profileId) overrides[agent] = profileId
    }
    return Object.keys(overrides).length > 0 ? overrides : undefined
  }

  // Preset → map tier to first profile of that tier
  const tierMap: Record<QualityPreset, string> = {
    economy:  'fast',
    standard: 'balanced',
    power:    'powerful',
    auto:     '',      // unreachable
    custom:   '',      // unreachable
  }
  const tier = tierMap[llmPreset]
  const profile = availableProfiles.find(p => p.tier === tier)
  if (!profile) return undefined

  return { PLANNER: profile.id, WRITER: profile.id, REVIEWER: profile.id }
}
```

**Intégration dans handleSubmit :**

```ts
const llmOverrides = computeLlmOverrides()
if (llmOverrides) body['llm_overrides'] = llmOverrides
```

---

### 2. Section UI (dans le formulaire, après le toggle web search)

```
<Collapsible open={llmSectionOpen} onOpenChange={setLlmSectionOpen}>
  <CollapsibleTrigger className="...">
    ▸ {t('run.llm.section_label')}
  </CollapsibleTrigger>
  <CollapsibleContent>

    <!-- Preset radio group -->
    <RadioGroup value={llmPreset} onValueChange={setLlmPreset}>
      <RadioItem value="auto">    {t('run.llm.preset.auto')}     — hint </RadioItem>
      <RadioItem value="economy"> {t('run.llm.preset.economy')}  — hint </RadioItem>
      <RadioItem value="standard">{t('run.llm.preset.standard')} — hint </RadioItem>
      <RadioItem value="power">   {t('run.llm.preset.power')}    — hint </RadioItem>
      <RadioItem value="custom">  {t('run.llm.preset.custom')}           </RadioItem>
    </RadioGroup>

    <!-- Custom selects (visible seulement si preset === 'custom') -->
    {llmPreset === 'custom' && availableProfiles && (
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-3">
        {(['PLANNER', 'WRITER', 'REVIEWER'] as const).map(agent => (
          <div key={agent}>
            <Label>{t(`run.llm.agent.${agent.toLowerCase()}`)}</Label>
            <Select
              value={customOverrides[agent] ?? '__auto__'}
              onValueChange={v => setCustomOverrides(prev => ({
                ...prev,
                [agent]: v === '__auto__' ? '' : v,
              }))}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__auto__">{t('run.llm.model_auto')}</SelectItem>
                {availableProfiles.map(p => (
                  <SelectItem key={p.id} value={p.id}>
                    {formatProfileLabel(p)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
      </div>
    )}

  </CollapsibleContent>
</Collapsible>
```

**Format du label modèle :**

```ts
function formatProfileLabel(p: AvailableProfile): string {
  // "Claude Sonnet · $3.00/M in" — jamais de model_string brut
  const name = p.id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  return `${name} · $${p.cost_per_1m_input_tokens.toFixed(2)}/M in`
}
```

---

### 3. Composant nécessaire : `Collapsible`

Vérifier si shadcn/ui `Collapsible` est déjà dans `components/ui/`.
Si non, installer : `npx shadcn@latest add collapsible`.
Si `RadioGroup` n'est pas installé : `npx shadcn@latest add radio-group`.

---

### 4. `locales/en.json` + `locales/fr.json`

Ajouter les clés listées dans la spec §7.

---

## Cas limites UX

**Aucun profil activé :** la section est masquée (pas de skeleton, pas de broken UI).

**Un seul profil activé :** les presets Economy/Standard/Power sont désactivés si leur
tier n'a pas de profil. Seuls les presets avec un profil disponible sont cliquables.

**Profils chargent lentement :** la section affiche un skeleton ou un spinner.
Le formulaire reste submittable avec `llm_overrides: undefined` (Auto).

**Preset sélectionné puis profil désactivé côté admin entre-temps :**
L'API retournera 422 → message d'erreur visible dans le formulaire.

---

## Tests

Pas de test unitaire pour le composant (c'est un 'use client' page).
Vérification manuelle :
1. Section fermée par défaut ✓
2. Preset Auto = pas de `llm_overrides` dans le POST ✓
3. Preset Power = override avec le profil `powerful` ✓
4. Custom + sélection manuelle = override ciblé ✓

---

## Critère de complétion

- `npx tsc --noEmit` passe
- Clés i18n présentes en EN et FR
- Section fermée par défaut, non-bloquante si l'endpoint échoue
- Run créé avec preset Power utilise le modèle attendu
