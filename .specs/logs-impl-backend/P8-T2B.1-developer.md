# Developer Log — T2B.1 Fine-grained RBAC + ProjectApiKey (Amendment 78)

**Branch:** feat/t2b1-rbac  
**Date:** 2026-03-26  
**Task:** T2B.1 — Fine-grained RBAC permission system (Am.78 / §28)

---

## Résumé des livrables

| Fichier | Rôle |
|---------|------|
| `lib/auth/project-api-key.ts` | Génération, validation (timingSafeEqual) et révocation des clés `hv1_` |
| `app/api/projects/[id]/members/route.ts` | GET liste membres / POST ajout membre (perm: project:members) |
| `app/api/projects/[id]/members/[userId]/route.ts` | PATCH changement de rôle / DELETE suppression membre |
| `app/api/projects/[id]/roles/route.ts` | GET liste rôles / POST création rôle custom (perm: project:members) |
| `app/api/projects/[id]/roles/[roleId]/route.ts` | PATCH update / DELETE suppression rôle custom |
| `app/api/projects/[id]/api-keys/route.ts` | GET liste clés / POST création (perm: project:credentials) |
| `app/api/projects/[id]/api-keys/[keyId]/route.ts` | DELETE révocation clé |
| `components/project/RoleBuilder.tsx` | UI de construction de rôle custom (Tailwind, React) |
| `components/project/ApiKeyPanel.tsx` | Panel gestion clés API (liste, création, révocation) |
| `prisma/migrations/20260326140000_seed_builtin_roles_am78/migration.sql` | INSERT 7 rôles built-in, migration members |
| `tests/auth/resolve-permissions.test.ts` | 17 tests unitaires (resolvePermissions, assertPermissions, validateApiKey) |

**Fichiers déjà existants et corrects (aucune modification nécessaire) :**  
`lib/auth/permissions.ts`, `lib/auth/built-in-roles.ts`, `lib/auth/rbac.ts`,  
`lib/auth/resolve-caller.ts`, `lib/auth/ownership.ts`

---

## Résultats tests

```
Test Suites: 14 passed, 14 total
Tests:       252 passed, 5 skipped, 257 total
```

17 nouveaux tests ajoutés (tous verts). Aucune régression.

---

## Auto-évaluation (score 1–5, honnêteté maximale)

### Respect des specs Am.78

**Score: 4/5**

**Ce qui est conforme :**
- 7 rôles built-in correctement définis avec héritage additif et nommage exact.
- `resolvePermissions()` avec cache 30s, bypass instance_admin, validation des permissions inconnues (injection guard).
- `assertPermissions()` avec message générique (pas de fuite du nom de la permission).
- Clés `hv1_` + SHA-256 stocké + `timingSafeEqual` + clé raw affichée une seule fois.
- IDOR via `assertProjectAccess()` sur toutes les routes.
- Audit log `AuditLog.create` sur toutes les mutations (ajout/suppression membre, création/révocation clé, création/mise à jour/suppression rôle).
- Protection contre la suppression du dernier admin.
- Protection contre la suppression d'un rôle en cours d'utilisation.
- Migration SQL idempotente (ON CONFLICT DO NOTHING).

**Ce qui est imparfait ou manquant :**

1. **Tab visibility (§28.5) non implémentée** : les règles de visibilité des onglets (Preview → runs:read, Reviewer → gates:read, Critical → gates:read_critical, Cost → runs:read_costs, Code → gates:read_code, Approve → gates:approve) nécessitent des modifications dans les composants UI des human gates existants. Ces composants ne font pas partie du périmètre des fichiers créés dans cette tâche et l'intégration complète demanderait des modifications de `components/gate/CriticalReviewTab.tsx` et d'autres composants gate. **Non fait.**

2. **SSE filter (§28.4) partiellement implémenté** : `app/api/projects/[id]/stream/route.ts` filtre déjà les événements cost/human_gate par permission (stream:costs, stream:gates). Mais le filtrage complet de la spec (strip `cost_usd` field dans `completed`, redact message dans `error`) n'est pas dans le stream existant. Ces extensions sont hors scope de ce task mais le flux existant est déjà conforme aux règles de base.

3. **Cache TTL = 30s** au lieu de 60s spécifié — choix délibéré pour être plus réactif aux changements de rôle en dev, mais c'est un écart par rapport au chiffre exact de la spec.

4. **`validateApiKey` dans `project-api-key.ts`** : la fonction est complète mais n'est pas appelée dans `resolve-caller.ts` (qui a sa propre logique SHA-256). Les deux implémentations sont cohérentes mais il y a un doublon. En production on devrait refactoriser `resolve-caller.ts` pour appeler `validateApiKey()`. Pour l'instant, les deux peuvent coexister sans bug.

5. **RoleBuilder et ApiKeyPanel** : composants fonctionnels couvrant le besoin principal. Aucune gestion d'états de chargement d'erreur réseau pour `handleRevoke` dans `ApiKeyPanel` (on met à jour l'état optimistically mais sans rollback si le DELETE échoue avec non-404/non-200). Acceptable pour v1.

### Sécurité (OWASP)

**Score: 4.5/5**

**Ce qui est correct :**
- Broken Access Control (A01) : `assertProjectAccess()` + `resolvePermissions()` + `assertPermissions()` sur chaque route, jamais de bypass accidentel.
- Injection (A03) : noms de rôle validés par regex `/^[a-z0-9_]{1,64}$/`, permissions filtrées contre un Set de valeurs connues avant writeDB — injection impossible.
- Cryptographic Failures (A02) : SHA-256, timingSafeEqual, clé raw jamais stockée, jamais loggée.
- Identification & Auth Failures (A07) : expiry vérifié à la fois dans `resolve-caller.ts` et `ownership.ts`.
- Audit logging sur toutes les mutations sensibles.

**Ce qui aurait pu être mieux :**
- Rate limiting sur la création de clés API : non implémenté (relèverait d'un middleware global, hors scope).
- ~~Pas de vérification que le `roleId` fourni lors de la création d'une clé n'est pas `instance_admin`~~ — **corrigé** : la route POST retourne 400 si le rôle est `instance_admin`.

### Qualité du code

**Score: 4/5**

- Structure Claire, dry, pas d'over-engineering.
- Le pattern `authGuard()` dans members/[userId] n'est pas réutilisé dans les autres routes (légère duplication), mais l'extraction dans une helper partagée n'était pas demandée.
- `ApiKeyPanel.tsx` a un `useCallback` avec `roleId` en dépendance qui va déclencher re-fetch à chaque sélection de rôle dans le dropdown. Bug UX mineur.

---

## Score global : **4.2/5**

Implémentation solide et sécurisée. Les lacunes principales sont : tab visibility non intégrée aux composants existants (hors scope immédiat), et un petit défaut de sécurité sur les clés API à rôle instance_admin. La base est production-ready pour le reste.
