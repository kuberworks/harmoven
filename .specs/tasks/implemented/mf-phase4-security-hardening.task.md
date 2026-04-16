---
title: "MF-Phase4 — Security hardening artifacts (S1–S4)"
spec: .specs/tasks/draft/multi-format-artifact-output.feature.md#security-hardening
depends_on: []
created: 2026-04-08
status: todo
round: 1
branch: feat/mf-phase4-security-hardening
---

## Objectif

Corriger 4 failles de sécurité sur les artifacts existants.
**Aucune dépendance** sur les autres phases — peut être mergé en production immédiatement.

---

## Fichiers à modifier / créer

### S1 [P0] — `app/api/runs/[runId]/artifacts/[artifactId]/route.ts`

Remplacer la réponse existante par :
```ts
// Forcer attachment pour TOUS les artifacts, sans exception
return new NextResponse(artifact.data, {
  headers: {
    'Content-Disposition':    `attachment; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`,
    'Content-Type':           'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control':          'private, no-store',
  },
})
```
Le `mime_type` stocké ne sert jamais dans les headers HTTP — uniquement pour les icônes UI.

### S3 [P1] — même fichier

Ajouter `artifact_role: { not: 'discarded' }` dans la requête Prisma :
```ts
const artifact = await db.runArtifact.findFirst({
  where: {
    id:     artifactId,
    run_id: runId,
    artifact_role: { not: 'discarded' },  // S3 — artifacts discarded → 404
  },
})
if (!artifact) return NextResponse.json({ error: 'Not Found' }, { status: 404 })
```

**Note S3 :** si le champ `artifact_role` n'existe pas encore en DB (phase 1 non mergée), utiliser un try/catch sur le champ Prisma ou s'assurer que la migration MF-Phase1 est passée d'abord.

### S2 [P1] — `lib/execution/converters/sanitize.ts` — NOUVEAU

```ts
// lib/execution/converters/sanitize.ts

/**
 * S2 — CSV formula injection guard.
 * Cells starting with = + - @ are prefixed with a single quote.
 * Standard anti-injection technique (Excel / LibreOffice).
 */
export function sanitizeCsvCell(cell: string): string {
  return /^[=+\-@]/.test(cell) ? `'${cell}` : cell
}

export function sanitizeCsvFormulas(csv: string): string {
  return csv
    .split('\n')
    .map(row =>
      row
        .split(',')
        .map(cell => sanitizeCsvCell(cell.trim()))
        .join(',')
    )
    .join('\n')
}

/**
 * S4 — Filename injection guard.
 * Strips CRLF and forbidden chars. Used to build the filename stored in DB.
 * The HTTP header uses encodeURIComponent() in addition (see S1 above).
 */
export function buildFilename(slug: string, ext: string): string {
  const safe = slug
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^a-z0-9\u00e0-\u024f]+/gi, '-')
    .replace(/(^-+|-+$)/g, '')
    .slice(0, 48) || 'output'
  return `${safe}.${ext}`.replace(/[\r\n"\\]/g, '_')
}
```

### S4 — Pas de nouveau fichier

`buildFilename` est créé dans `sanitize.ts` ci-dessus.
Le header HTTP dans S1 utilise déjà `encodeURIComponent`.

### Tests

**`tests/execution/converters/sanitize.test.ts`** — NOUVEAU :
```ts
import { sanitizeCsvFormulas, buildFilename } from '@/lib/execution/converters/sanitize'

describe('sanitizeCsvFormulas', () => {
  it('prefixes = cells', () => {
    expect(sanitizeCsvFormulas('a,=SUM(A1)')).toBe("a,'=SUM(A1)")
  })
  it('prefixes + - @ cells', () => {
    const result = sanitizeCsvFormulas('+bad,-bad,@bad,normal')
    expect(result).toBe("'+bad,'-bad,'@bad,normal")
  })
  it('leaves safe cells unchanged', () => {
    expect(sanitizeCsvFormulas('hello,world')).toBe('hello,world')
  })
})

describe('buildFilename', () => {
  it('strips CRLF', () => {
    expect(buildFilename('file\r\nname', 'csv')).toBe('file__name.csv')
  })
  it('normalizes accented chars', () => {
    expect(buildFilename('Résuméé', 'txt')).toMatch(/^r.+\.txt$/)
  })
})
```

**`tests/api/artifact-security.test.ts`** — NOUVEAU :
Tester que `GET /api/runs/:runId/artifacts/:id` retourne :
- `Content-Disposition: attachment` (header présent)
- `Content-Type: application/octet-stream`
- 404 pour un artifact avec `artifact_role = 'discarded'`

---

## Critères de validation

- [ ] `GET /api/runs/:runId/artifacts/:id` retourne `Content-Disposition: attachment` et `Content-Type: application/octet-stream` quelle que soit la valeur de `mime_type` stocké
- [ ] HTML artifact téléchargé, pas exécuté dans le navigateur
- [ ] `sanitizeCsvFormulas('=SUM()')` retourne `'=SUM()`
- [ ] `buildFilename` ne contient pas de `\r\n`
- [ ] `npx tsc --noEmit` passe avec zéro erreur
- [ ] Tous les tests Jest passent

---

## Commit

```
fix(security): enforce attachment download + CSV formula guard + filename sanitize

- app/api/runs/[runId]/artifacts/[artifactId]/route.ts: Content-Disposition attachment,
  Content-Type application/octet-stream, X-Content-Type-Options (S1),
  filter artifact_role: { not: 'discarded' } (S3)
- lib/execution/converters/sanitize.ts: sanitizeCsvFormulas() (S2), buildFilename() (S4)
- tests/execution/converters/sanitize.test.ts: S2 + S4 unit tests
- tests/api/artifact-security.test.ts: S1 + S3 integration tests
```
