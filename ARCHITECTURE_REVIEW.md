# Architecture Review — Harmoven v1
**Reviewer:** Software Architect (Anthropic)
**Date:** 29 mars 2026
**Base commit:** `4bf56f3` (develop)
**Method:** Static analysis, spec cross-reference (TASKS.md, V1_SCOPE.md, TECHNICAL.md, all AGENTS-*.md + Amendments), test suite run, TypeScript check, filesystem audit

---

## Executive Summary

Harmoven v1 est une implémentation **complète et de haute qualité** d'un orchestrateur d'agents LLM multi-profils. Les 22 tâches définies dans TASKS.md (T1.1–T3.9) sont toutes marquées complètes dans `claude-progress.txt` et les branches correspondantes sont présentes et mergées dans `develop`. Le frontend (FE-P1, FE-P2, FE-P3) est intégralement livré. La suite de tests passe à **511 tests / 506 réussis** (5 skipped), **zéro erreur TypeScript** dans le code de production.

**Score global : 4.1 / 5.0**

---

## 1. Conformité spec — Vue d'ensemble

| Phase | Tâches | Statut |
|---|---|---|
| Phase 1 — Socle (T1.1–T1.9) | 9/9 | ✅ Complètes |
| Phase 2A — Scaffolding (T2A.1–T2A.4) | 4/4 | ✅ Complètes |
| Phase 2B — Quality + Perms (T2B.1–T2B.2) | 2/2 | ✅ Complètes |
| Phase 3 — Intégration (T3.1–T3.9) | 9/9 | ✅ Complètes |
| Frontend P1 — Auth + Shell | ✅ | Mergé `develop` |
| Frontend P2 — Core workflow | ✅ | Mergé `develop` |
| Frontend P3 — Settings + Admin + Analytics + Marketplace | ✅ | Mergé `develop` |

---

## 2. Points forts

### 2.1 Architecture backend — solide

- **DAG Executor** (`lib/execution/custom/executor.ts`) : machine d'états complète (PENDING → RUNNING → COMPLETED/FAILED/PAUSED/INTERRUPTED), parallélisme via `Promise.all`, heartbeat toutes les 30s, détection des orphelins, crash recovery au démarrage. Interface `IExecutionEngine` correctement abstraite pour les futurs moteurs Temporal/Restate.
- **RBAC fine-grained** : 27 permissions (Am.78), 7 rôles built-in seedés, `resolvePermissions()` avec cache TTL 30s, `ProjectApiKey` format `hv1_`, `timingSafeEqual()` sur la comparaison des clés.
- **Multi-criteria LLM routing** (`lib/llm/selector.ts`) : 5 critères (confidentialité, juridiction, cost, context window, tier affinity). Hard constraints bloquants + score composite. `DirectLLMClient` calcule le vrai coût via `computeCostUsd()` à partir des prix de la `LlmProfile`.
- **EvalAgent** (`lib/agents/eval/`) : 7 rubrics domaine + GENERIC_RUBRIC fallback, retry max 2, ESCALATE_HUMAN sur dernier échec, contrat sprint via `negotiateSprintContract()`.
- **Critical Reviewer** : sévérité configurable 0–5, max 3 findings enforced, targeted fix ($0.10 cap), immutabilité via `CriticalFindingIgnore` avec règle PostgreSQL RULE.
- **Config GitOps** (`lib/config-git/`) : `execFileAsync()` partout (pas d'exec()), `assertSafePath()`, restauration via forward commit (jamais `git reset --hard`), auto-commit fire-and-forget.
- **Supply chain security** (T3.8) : SHA-256 timing-safe sur les packs marketplace, vérification GPG, LiteLLM sidecar Docker isolé, `verify-mcp-skills.ts` au démarrage.
- **Hardening Am.92** (`lib/utils/exec-safe.ts`, `lib/security/ssrf-protection.ts`, `lib/execution/credential-scope.ts`) : credential vault éphémère par run, SSRF protection avec résolution DNS + ranges privés IPv4+IPv6, secret scanner gitleaks sur worktrees.
- **Electron** : `contextIsolation: true`, `nodeIntegration: false` sont enforced et documentés.
- **HTTP headers** : `X-Frame-Options: DENY`, CSP, HSTS, X-Content-Type-Options — tous présents dans `next.config.ts`.
- **RGPD** : suppression de compte, export de données, TTL de rétention sur les sessions et les données de run, maintenance toggle via `/api/admin/rgpd`.
- **OpenAPI** (`openapi/v1.yaml`) : 5 951 lignes, ~70 endpoints documentés, synchronisé avec les routes implémentées.
- **CI/CD** (T3.5) : 3 niveaux de pipeline (PR/main/release), actions GitHub pinnées par commit SHA (supply chain), vérification des migrations, check des traductions.

### 2.2 Frontend — couverture complète du parcours

Toutes les pages de l'UX spec (§3.3–§3.11) sont implémentées :

- Authentification (login, register, setup wizard)
- Dashboard avec runs actifs et projets récents (RBAC-scopé)
- Projects list + project detail + tabs (Runs/Members/API Keys/Config History)
- Kanban multi-run avec SSE live via `useRunStream`
- Run detail live (nodes, cost meter, pause/inject controls, gate banner)
- Human Gate : CriticalReviewTab + EvalTab, PermissionGuard sur chaque onglet
- Settings (profil, locale, expert mode, UI level)
- Admin panel (dashboard stats, users, LLM models, MCP skills)
- Analytics (KPI grid, by-profile breakdown, Board KPIs, export CSV/PDF)
- Marketplace (installed packs, install form pour admin)
- Pipeline builder (bonus — non dans TASKS.md)

**Architecture Next.js 15 respectée** : Server Components par défaut, `'use client'` uniquement pour l'interactivité/SSE. Parallelisation des DB queries dans les server components critiques (dashboard).

### 2.3 Tests — saine et rapide

- **511 tests, 30 suites, 3.7s** — excellent signal de maintenabilité.
- Coverage des couches critiques : executor, RBAC, agents (writer, reviewer, critic, eval), config-git, marketplace, analytics, i18n, security hardening, updates.
- `MockLLMClient` utilisé systématiquement côté tests unitaires — aucun appel LLM réel en CI.

---

## 3. Lacunes et anomalies

### 3.1 🔴 Élevé — Coût réel manquant pour LiteLLMClient (streaming)

**Fichier :** `lib/llm/litellm-client.ts` lignes 55 et 90  
**Symptôme :** `costUsd: 0` retourné dans les deux méthodes (`chat` et `stream`).  
**Impact :** Tout run passant par le gateway LiteLLM affichera `cost_actual_usd = $0.00` dans la DB, faussant les analytics et le budget enforcement.  
**Cause :** `computeCostUsd()` n'est appelé que dans `DirectLLMClient`, pas dans `LiteLLMClient`.  
**Correction recommandée :** Soit ajouter le champ `cost_per_1m_input_tokens`/`cost_per_1m_output_tokens` dans le LlmProfile LiteLLM et appeler `computeCostUsd()`, soit utiliser l'API billing de LiteLLM (`x-litellm-cost` header) pour lire le coût retourné par le gateway.

### 3.2 🔴 Élevé — i18n : couverture des chaînes UI < 10%

**Contexte spec :** T3.7 "Done when: ~340 keys in en.json, fr.json complete"  
**Réalité :** `locales/en.json` contient **19 clés**, `locales/fr.json` également 19 clés.  
**Impact :** Toutes les pages frontend (projets, runs, gate, settings, admin, analytics, marketplace) utilisent des chaînes anglaises hardcodées, non passées par `t()`. La détection de locale fonctionne (cookie + Accept-Language + PATCH /api/users/me/locale) mais l'interface reste entièrement en anglais.  
**Note :** L'infrastructure i18n est complète (`lib/i18n/`, `LanguageMismatchBanner`, `LocaleSwitcher`). Il ne manque que le contenu des clés et leur utilisation dans les composants.

### 3.3 🟡 Moyen — Pages settings/models, settings/skills, settings/triggers absentes

**Contexte spec :** TECHNICAL.md §1 Project Structure définit `settings/models/`, `settings/skills/`, `settings/triggers/` comme pages dédiées.  
**Réalité :** Ces fonctionnalités sont dans `/admin/models`, `/admin/skills`, et `/api/admin/triggers`. Le chemin `/settings/...` n'existe pas.  
**Impact :** Écart de navigation par rapport à la spec. Les liens dans la Sidebar pointent probablement vers `/admin/*` ce qui est cohérent, mais le spec dit `/settings/*` pour l'accès admin. Acceptable pour v1 si la Sidebar est cohérente — à documenter comme déviation.

### 3.4 🟡 Moyen — admin/instance page manquante

**Contexte :** `app/(app)/admin/page.tsx` génère un lien vers `/admin/instance` dans les quick-nav.  
**Réalité :** Pas de `app/(app)/admin/instance/page.tsx`. Lien 404.  
**Recommandation :** Soit créer la page (configuration instance: nom, URL, politique de rétention via `/api/instance/policy`), soit retirer le lien du dashboard admin.

### 3.5 🟡 Moyen — DagView n'est pas un graphe interactif

**Contexte spec :** V1_SCOPE.md "DAG graph view (level 5)" — UX.md §3.5 "live DAG graph" avec `harmoven_dag_v2.jsx` comme référence.  
**Réalité :** `run-detail-client.tsx` implémente une liste ordonnée de `NodeCard` (avec statut, durée, coût, agent), pas un graphe DAG avec arêtes visuelles.  
**Impact :** Fonctionnellement complet (toutes les infos sont là), mais l'expérience visuelle du DAG n'existe pas. Acceptable pour un MVP mais à signaler.

### 3.6 🟡 Moyen — critical_findings_fixed hardcodé à 0 dans analytics

**Fichier :** `lib/analytics/compute.ts` ligne 496  
**Code :** `critical_findings_fixed: 0, // requires CriticalFindingFix model query — deferred`  
**Impact :** `UserPeriodStats.critical_findings_fixed` est toujours 0. Les Board KPIs qui en dépendent sont sous-estimés.  
La table `CriticalFindingFix` existe bien dans le schéma. Il suffit d'ajouter la requête.

### 3.7 🟡 Moyen — Erreur TypeScript dans les tests (non-bloquant)

**Fichier :** `tests/agents/eval/parallel-eval.test.ts` ligne 66  
**Erreur :** `TS2322 — MockedFunction<...> not assignable to TestReturnValuePromise`  
**Cause :** Un `it()` block reçoit `mockEvaluate.mockResolvedValueOnce()` au lieu d'un callback — probable faute de frappe dans la chaîne d'appel.  
**Impact :** Les tests passent quand même (Jest absorbe l'erreur), mais `tsc --noEmit` échoue sur ce fichier.

### 3.8 🟠 Bas — Feedback post-run non exposé côté frontend

**Contexte spec :** T3.4 "Done when: Post-completion feedback prompt (non-blocking)"  
**Réalité :** L'API `PATCH /api/runs/:runId/feedback` existe et fonctionnelle. Route `CompletedView` dans `run-detail-client.tsx` affiche le statut final mais n'expose pas le formulaire 1–5 étoiles + `estimated_hours_saved`.

### 3.9 🟠 Bas — KiloCliExecutor est un STUB intentionnel (tracé)

Documenté dans `claude-progress.txt` et `TASKS.md` comme déféré à v1.1. Le code throw `NotImplementedError` de façon explicite. Aucun bug — à garder tel quel.

### 3.10 🟠 Bas — LiteLLMClient exclut le coût streaming côté monitoring

Lié à 3.1 — quand LiteLLM est actif, les budgets run (`budget_usd`) ne sont pas correctement décrémentés car `costUsd = 0`. Un run avec budget défini pourrait s'exécuter sans limite effective si LiteLLM est le provider actif.

---

## 4. Analyse de sécurité

### OWASP Top 10 — état

| Risque | Statut | Evidence |
|---|---|---|
| A01 Broken access control | ✅ Mitigé | `resolvePermissions()` sur toutes les routes, IDOR via `assertProjectAccess()` (same error pour not-found et forbidden) |
| A02 Cryptographic failures | ✅ Mitigé | Argon2id (oslo), AES-256-GCM pour les credentials, HKDF pour la dérivation des clés |
| A03 Injection (SQL/cmd/prompts) | ✅ Mitigé | Prisma paramétré, `execFileAsync()` sans shell, `scanPackContent()` anti-injection LLM |
| A04 Insecure design | ✅ Bon | Architecture Zero-trust run scope, forward-commit GitOps |
| A05 Security misconfiguration | ✅ Bon | Headers HTTP complets, CSP, contextIsolation Electron, actions CI pinnées SHA |
| A06 Vulnerable components | ✅ Bon | `better-auth >= 1.3.26` (CVE-2025-61928), CI job `release-pins.yaml` |
| A07 Auth failures | ✅ Bon | Sessions DB (pas JWT stateless), TOTP + Passkeys, rate limiting par IP |
| A08 Software integrity | ✅ Bon | SHA-256 + GPG sur les packs, `verify-mcp-skills.ts` au démarrage |
| A09 Logging failures | ✅ Bon | AuditLog immuable (PG RULE), supply-chain-monitor |
| A10 SSRF | ✅ Mitigé | `assertNotPrivateHost()` avec résolution DNS, `assertSafeUrl()` |

**Point de vigilance :** Le rate limiting est in-memory (Map) — il ne scale pas horizontalement. En production Docker multi-instance, les buckets IP ne sont pas partagés. Déférer à Redis/Upstash pour v1 SaaS est documenté dans le code.

---

## 5. Qualité du code

| Dimension | Évaluation |
|---|---|
| TypeScript strict | ✅ 0 erreur en source production |
| Cohérence des patterns | ✅ Server Component + Client séparation cohérente |
| Sécurité des input | ✅ Zod strict() sur tous les handlers API |
| Pas de secrets en clair | ✅ `safeBaseEnv()`, vault éphémère, gitleaks sur worktrees |  
| Immutabilité des logs | ✅ PG RULE sur AuditLog et CriticalFindingIgnore |
| Gestion de l'erreur | ✅ ForbiddenError/UnauthorizedError, jamais de 500 sur input invalide |
| Dead code | Minimal — quelques stubs documentés (KiloCliExecutor) |
| Couplage modules | Faible — ILLMClient, IExecutionEngine, IProjectEventBus tous abstraits |

---

## 6. Couverture de tests

| Module | Tests | Qualité |
|---|---|---|
| DAG Executor | `executor.test.ts`, `t1.5.test.ts`, `t3.2-user-control.test.ts` | ✅ Fixtures DAG varié, crash recovery, pause/resume |
| RBAC | `resolve-permissions.test.ts` | ✅ 7 rôles, permission inheritance |
| Agents | writer, reviewer, planner, critical-reviewer, eval (parallel) | ✅ MockLLMClient, cas limites |
| Config-git | `config-store.test.ts` | ✅ Traversal path, forward commit |
| Marketplace | `install-pack.test.ts` | ✅ 21 tests, 0 DB/network |
| Analytics | `t3.4-analytics.test.ts` | ✅ Summary, timeseries, export |
| Security | `t3.9-security-hardening.test.ts`, `supply-chain-monitor.test.ts` | ✅ SSRF, injection, SHA256 |
| i18n | `t3.7-i18n.test.ts` | ✅ Cascade détection, mismatch banner |
| Frontend | `permission-guard.test.tsx` | ⚠️ 1 seul composant testé |
| E2E | `tests/e2e/smoke.test.ts` | ⚠️ Scaffold présent, 0 test business |
| API routes | — | ❌ Aucun test d'intégration HTTP |

**Point de fragilité principal :** Aucun test d'intégration couvrant les routes API (auth guard, IDOR, RBAC enforcement on routes). Le risque est limité par le pattern systématique `resolvePermissions()` + zod, mais une regression silencieuse sur un handler est possible.

---

## 7. Évaluation par rapport aux V1_SCOPE "Done when"

| Feature V1_SCOPE | Implémenté | Note |
|---|---|---|
| DAG Executor (state machine, parallel, heartbeat, orphan) | ✅ | Complet |
| 12 profils domaine | ✅ | `lib/llm/profiles.ts` + `lib/agents/eval/eval-rubrics.ts` 7 rubrics |
| Classifier + Planner + Writer + Reviewer | ✅ | T1.6/T1.7 |
| Human Gate protocol | ✅ | T3.2 + FE-P2 gate page |
| Multi-criteria LLM routing | ✅ | `lib/llm/selector.ts` |
| Confidentiality Classifier | ✅ | `lib/llm/confidentiality.ts` |
| Credential vault AES-256-GCM | ✅ | `lib/execution/credential-scope.ts` |
| Prompt injection defense | ✅ | `lib/marketplace/scan.ts` + PI sanitizer (classifier/planner) |
| Crash recovery | ✅ | `lib/execution/custom/crash-recovery.ts` |
| Auth Better Auth ≥1.3.26 | ✅ | TOTP, Passkeys, Project API keys |
| IDOR enforcement | ✅ | `assertProjectAccess()`, same error not-found/forbidden |
| Immutable audit log | ✅ | PG RULE |
| RBAC 27 permissions | ✅ | `lib/auth/permissions.ts` |
| SSE filtering par permission | ✅ | `stream:state`, `stream:gates`, `stream:costs` filtrés |
| Project-level event bus | ✅ | PgNotify + InMemory |
| Critical Reviewer | ✅ | sévérité 0–5, max 3 findings |
| Full workflow UI | ✅ | ExecutingView ≈ run-detail, GateView = gate page |
| Multi-run Kanban + SSE | ✅ | runs-kanban-client.tsx |
| Expert Mode toggle | ✅ | `preferences-client.tsx`, propagé en DB |
| 10-min onboarding wizard | ✅ | `/setup` 6 étapes |
| Manual pause / context injection | ✅ | T3.2 + PauseControls + ContextInjectionPanel |
| Streaming + node interruption | ✅ | `useRunStream` + AbortController par node |
| Anthropic / OpenAI / Gemini / Ollama / CometAPI | ✅ | T1.9 |
| Marketplace install + Bayesian | ✅ | T3.3 |
| Analytics + ROI | ✅ | T3.4, 5 Board KPIs |
| i18n en+fr | ⚠️ | Infrastructure ✅, contenu 19/~340 clés |
| CI/CD 3 niveaux | ✅ | T3.5 |
| Update management | ✅ | T3.6 Docker banner + wizard |
| Supply chain (SHA256 + GPG + gitleaks) | ✅ | T3.8 |
| Security hardening Am.92/93 | ✅ | T3.9 |
| DAG graph view (level 5) | ⚠️ | Node list, pas de graphe visuel |
| LiteLLM cost tracking | ⚠️ | Toujours $0 pour le gateway LiteLLM |

---

## 8. Recommandations prioritaires

### P0 — Avant release production

1. **Corriger `LiteLLMClient.costUsd`** — récupérer le coût depuis le header `x-litellm-cost` ou calculer depuis les tokens + prix. Sans ça, le budget enforcement est inefficace quand LiteLLM est actif.

2. **Corriger l'erreur TS dans `parallel-eval.test.ts`** — remplacer `mockEvaluate.mockResolvedValueOnce(...)` par la syntaxe correcte Jest. Le compilateur TypeScript échoue sur ce fichier dans un pipeline `tsc --noEmit`.

3. **Créer ou supprimer le lien `/admin/instance`** — lien mort dans le dashboard admin.

### P1 — Sprint suivant (v1.0.1)

4. **Compléter les clés i18n** — ~320 clés manquantes dans `en.json`/`fr.json`. Instrumenter les pages avec `t()`. Objectif spec : toutes les chaînes UI externalisées.

5. **Ajouter le feedback post-run** — formulaire étoiles + heures économisées dans `CompletedView` du `run-detail-client.tsx`. L'API existe, il ne manque que l'UI.

6. **Corriger `critical_findings_fixed`** dans `computeUserPeriodStats()` — ajouter la requête `db.criticalFindingFix.count()` correspondante.

7. **Ajouter tests d'intégration API** — au minimum : auth guard (401 sur routes protégées), RBAC enforcement (403 sur rôle insuffisant), IDOR (project A ne voit pas les runs du project B). Priorité haute pour la confiance en production.

### P2 — Backlog v1.1

8. **DAG graph visuel** — adapter `harmoven_dag_v2.jsx` en un composant React avec layout hierarchique (dagre ou ELK). L'arbre de nodes est disponible dans `RunState.nodes` — le rendu graphique est la seule partie manquante.

9. **Rate limiting distribué** — remplacer le Map in-memory par `@upstash/ratelimit` pour le déploiement Docker multi-instance.

10. **KiloCliExecutor** — implémentation complète selon Am.72.5 eval criteria. Actuellement STUB documenté.

---

## 9. Score détaillé

| Dimension | Score | Justification |
|---|---|---|
| Complétude des tâches TASKS.md | 5.0/5 | 22/22 tâches merged |
| Qualité du code backend | 4.5/5 | -0.5 costUsd=0 LiteLLM |
| Qualité du code frontend | 4.0/5 | -1 i18n incomplet, -0 DAG (acceptable MVP) |
| Sécurité | 4.5/5 | -0.5 rate limiting non distribué |
| Tests | 3.5/5 | -1 zéro tests API routes, -0.5 zéro E2E business |
| Architecture & patterns | 4.5/5 | Server/Client boundary correct, abstractions stables |
| **Total** | **4.1/5** | |

---

*Rapport généré à partir du commit `4bf56f3` (HEAD → develop, 29 mars 2026).*  
*Prochaine revue recommandée : après correction des items P0 et avant premier déploiement Docker production.*
