# Harmoven

**Multi-tenant AI agent orchestration platform.** Submit a prompt, Harmoven runs it through a multi-LLM pipeline (Classifier → Planner → Writer → Reviewer), enforces human-gate approvals, tracks every token and dollar, and exposes the entire flow over a versioned REST API.

Self-host on Docker Compose in minutes. Built for teams that cannot send sensitive data to third-party SaaS services.

---

## What it does

| Feature | Detail |
|---|---|
| **Multi-agent pipeline** | CLASSIFIER → PLANNER → WRITER → REVIEWER, parallelisable via a DAG engine |
| **Human-in-the-loop gates** | Pause any run at a defined checkpoint for human approval before continuing |
| **Multi-LLM routing** | Per-node LLM selection based on confidentiality level, jurisdiction, estimated tokens |
| **RBAC** | 7 roles, 27 permissions, per-project membership — enforced at API and UI layer |
| **Audit log** | Immutable PostgreSQL-level log (UPDATE/DELETE blocked by DB rules) |
| **REST API** | Versioned OpenAPI v1, suitable for CI/CD integration |
| **Marketplace** | Install skill packs; run `GET /api/marketplace` for available packs |
| **i18n** | English and French, switchable per user |

---

## Requirements

| Dependency | Version |
|---|---|
| Node.js | ≥ 22 |
| Docker + Docker Compose | v2+ |
| PostgreSQL | 16 (included in Compose) |
| Anthropic API key | Required — [console.anthropic.com](https://console.anthropic.com) |

---

## Quick start (Docker Compose — 5 minutes)

### 1. Clone and copy env template

```bash
git clone https://github.com/your-org/harmoven.git
cd harmoven
cp .env.example .env
```

### 2. Fill in the required secrets in `.env`

```bash
# Mandatory
DATABASE_URL=postgresql://harmoven:CHANGE_ME@db:5432/harmoven
AUTH_SECRET=$(openssl rand -base64 32)       # Windows: see CONTRIBUTING.md
ANTHROPIC_API_KEY=sk-ant-...

# Optional — only if you want a second LLM provider
# OPENAI_API_KEY=sk-...
```

> All variables are documented inline in `.env.example`. Never commit `.env`.

### 3. Start

```bash
docker compose up -d
```

The app starts at **http://localhost:3000**.

On first boot, a **setup token** is printed in Docker logs. Navigate to `/setup`, enter the token, and complete the 4-step wizard (admin account + LLM profile).

```bash
# See the token
docker compose logs app | grep "setup token"
```

### 4. Verify

```bash
curl http://localhost:3000/api/health
# → {"status":"ok"}
```

---

## Development setup (local, no Docker)

```bash
# Install dependencies
npm install

# Run DB via Docker, app locally
docker compose up db -d
cp .env.example .env   # fill in DATABASE_URL pointing to localhost

# Generate Prisma client and run migrations
npm run db:generate
npm run db:migrate

# Start dev server
CONFIG_GIT_DIR=/tmp/harmoven-config-git npm run dev
```

> `CONFIG_GIT_DIR` tells the config-git module where to store the local git mirror of `orchestrator.yaml`. Any writable path works in development.

---

## Configuration

Two files control runtime behaviour — keep them in version control (no secrets in either):

| File | Purpose |
|---|---|
| `orchestrator.yaml` | Org name, preset, LLM profiles, security policy, rate limits |
| `.env` | Secrets only — never committed |

### Presets (`orchestrator.yaml → organization.preset`)

| Preset | Description |
|---|---|
| `small_business` | Low concurrency, cost cap $10/day, memory rate limiter |
| `enterprise` | Higher concurrency, Upstash rate limiter, Presidio PII detection opt-in |
| `developer` | Relaxed limits, MFA optional for non-admins |

---

## Optional: LiteLLM gateway (multi-provider routing)

To use OpenAI, Mistral, or local models alongside Anthropic, enable the LiteLLM sidecar:

```bash
docker compose --profile litellm up -d
```

Then set `LITELLM_GATEWAY_URL=http://litellm:4000` in `.env` (already the default in Compose).

---

## npm scripts

```bash
npm run dev              # Start local dev server (Next.js)
npm run build            # Production build
npm run test             # All tests (unit + integration)
npm run test:unit        # Unit tests only
npm run test:integration # Integration tests (requires live DB)
npm run test:e2e         # E2E tests (Playwright — scaffold pending)
npm run lint             # ESLint
npm run typecheck        # tsc --noEmit
npm run db:migrate       # Run pending Prisma migrations
npm run db:seed          # Seed DB with demo data
npm run db:studio        # Open Prisma Studio
npm run generate:openapi # Regenerate openapi/v1.yaml
```

---

## REST API

OpenAPI spec: [`openapi/v1.yaml`](openapi/v1.yaml)

Base URL: `http://localhost:3000/api/v1`

Authentication: `Authorization: Bearer <project-api-key>` (prefix `hv1_`)

Key endpoints:

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/runs` | Submit a prompt, start a pipeline run |
| `GET` | `/v1/runs/:id` | Get run status + node outputs |
| `GET` | `/v1/runs/:id/stream` | SSE stream of run events |
| `POST` | `/v1/runs/:id/gate/:nodeId/approve` | Approve a human gate |
| `GET` | `/v1/projects` | List accessible projects |

---

## Architecture

```
Browser / API client
        │
        ▼
  Next.js App Router (Server Components + API routes)
        │
        ▼
  Execution Engine (lib/execution/)
  ┌─────────────────────────────────────┐
  │  DAG  →  Node queue                 │
  │  CLASSIFIER → PLANNER → WRITER      │
  │           → REVIEWER                │
  │  HumanGate (pause / resume)         │
  └─────────────────────────────────────┘
        │
        ▼
  LLM Router (lib/llm/)
  ┌──────────────────────────────────┐
  │ selectLlm(confidentiality,       │
  │           jurisdiction, tokens)  │
  │ → Anthropic direct               │
  │ → LiteLLM gateway (opt-in)       │
  └──────────────────────────────────┘
        │
        ▼
  PostgreSQL 16  (via Prisma)
  ┌──────────────────────────────────┐
  │ Projects · Runs · Nodes          │
  │ AuditLog (immutable, DB-enforced)│
  │ ProjectMember · RBAC roles       │
  └──────────────────────────────────┘
```

---

## Security highlights

- Argon2id password hashing, timing-safe API key comparison
- MFA (TOTP + Passkey) enforced for `instance_admin`
- SSRF protection: DNS + private IP block, fails closed
- CSP without `unsafe-eval` in production, HSTS 2 years
- Docker images pinned by SHA256 digest
- Immutable audit log (PostgreSQL-level, UPDATE/DELETE blocked)
- Rate limiting: 20 sign-in attempts / 15 min, 200 global
- Zero secrets in Docker images

See [`ARCHITECTURE_REVIEW.md`](ARCHITECTURE_REVIEW.md) for the full security audit.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `/setup` shows blank page | `SETUP_TOKEN` not set | Check `docker compose logs app \| grep token` |
| `PrismaClientInitializationError` | DB not ready | Run `docker compose up db -d`, wait 5s, retry |
| `AUTH_SECRET` error on startup | Missing or short secret | `openssl rand -base64 32` → paste into `.env` |
| Dev server crashes instantly | `CONFIG_GIT_DIR` not set | Prefix command with `CONFIG_GIT_DIR=/tmp/hv-cfg` |
| LLM calls fail with 401 | Wrong API key | Verify `ANTHROPIC_API_KEY` in `.env`, no trailing space |

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Branch naming: `feat/*`, `fix/*`, `docs/*`. All PRs target `develop`.

## Commands

Core workflow commands:

- [/sdd:add-task](add-task.md) - Create task template file with initial prompt
- [/sdd:plan](plan.md) - Analyze prompt, generate required skills and refine task specification
- [/sdd:implement](implement.md) - Produce working implementation of the task and verify it

Additional commands useful before creating a task:

- [/sdd:create-ideas](create-ideas.md) - Generate diverse ideas on a given topic using creative sampling techniques
- [/sdd:brainstorm](brainstorm.md) - Refine vague ideas into fully-formed designs through collaborative dialogue

## Available Agents

The SDD plugin uses specialized agents for different phases of development:

| Agent | Description | Used By |
|-------|-------------|---------|
| `researcher` | Technology research, dependency analysis, best practices | `/sdd:plan` (Phase 2a) |
| `code-explorer` | Codebase analysis, pattern identification, architecture mapping | `/sdd:plan` (Phase 2b) |
| `business-analyst` | Requirements discovery, stakeholder analysis, specification writing | `/sdd:plan` (Phase 2c) |
| `software-architect` | Architecture design, component design, implementation planning | `/sdd:plan` (Phase 3) |
| `tech-lead` | Task decomposition, dependency mapping, risk analysis | `/sdd:plan` (Phase 4) |
| `team-lead` | Step parallelization, agent assignment, execution planning | `/sdd:plan` (Phase 5) |
| `qa-engineer` | Verification rubrics, quality gates, LLM-as-Judge definitions | `/sdd:plan` (Phase 6) |
| `developer` | Code implementation, TDD execution, quality review, verification | `/sdd:implement` |
| `tech-writer` | Technical documentation, API guides, architecture updates, and lessons learned | `/sdd:implement` |

## Patterns

Key patterns implemented in this plugin:

- **Structured reasoning templates** — Includes Zero-shot and Few-shot Chain of Thought, Tree of Thoughts, Problem Decomposition, and Self-Critique. Each is tailored to a specific agent and task, enabling sufficiently detailed decomposition so that isolated sub-agents can implement each step independently.
- **Multi-agent orchestration for context management** — Context isolation of independent agents prevents "context rot," maintaining optimal LLM performance at each step. The main agent acts as an orchestrator that launches sub-agents and manages their workflow.
- **Quality gates based on LLM-as-Judge** — Evaluates the quality of each planning and implementation step using evidence-based scoring and predefined verification rubrics. This eliminates cases where an agent produces non-functional or incorrect solutions.
- **Continuous learning** — Automatically builds specific skills the agent needs to implement a task, which it might otherwise be unable to perform from scratch.
- **Spec-driven development pattern** — Based on the arc42 specification standard adjusted for LLM capabilities, this pattern eliminates elements of the specification that do not add value to implementation quality.
- **MAKER** — An agent reliability pattern introduced in [Solving a Million-Step LLM Task with Zero Errors](https://arxiv.org/abs/2511.09030). It minimizes agent mistakes caused by context accumulation and hallucinations by utilizing clean-state agent launches, filesystem-based memory storage, and multi-agent voting during critical decisions.

## Vibe Coding vs. Specification-Driven Development

This plugin is not a "vibe coding" solution, though it can function like one out of the box. By default, it is designed to work from a single prompt through to task completion, making reasonable assumptions and evidence-based decisions instead of constantly asking for clarification. This is because developer time is more valuable than model time, allowing the developer to decide how much time is worth spending on a task. The plugin will always produce functional results, but quality may be sub-optimal without human feedback.

To improve quality, you can correct the generated specification or leave comments using `//`, then run the `/sdd:plan` command again with the `--refine` flag. You can also verify each planning and implementation phase by adding the `--human-in-the-loop` flag. Majority of researches show that human feedback is the most effective way to improve results.

Our tests showed that even when the initially generated specification was incorrect due to missing information or task complexity, the agent was still able to self-correct until it reached a working solution. However, this process often took longer, as the agent explored incorrect paths and stopped more frequently. To avoid this, we strongly recommend decomposing complex tasks into smaller, separate tasks with dependencies and reviewing the specification for each one. You can add dependencies between tasks as arguments to the `/sdd:add-task` command, and the model will link them by adding a `depends_on` section to the task file's frontmatter.

Even if you prefer a less hands-on approach, you can still use the plugin for complex tasks without decomposition or human verification — though you may need tools to keep the session active for longer periods, for example ralph-loop.

Learn more about available customization options in [Customization](customization.md).

## FAQ

**Do I need to re-run `/plan` or `/implement` after context compaction (`/compact`)?**

After compaction, close the terminal and resume with `/plan --continue` or `/implement --continue`. This produces more predictable results than continuing in a compacted context. Using `/model sonnet[1m]` reduces compaction frequency.

**Do I need to prefix every prompt with `/plan` or `/implement`?**

No. Run these commands once to start the workflow. The only time to invoke them again is when you change the specification or code and want agents to update misaligned sections — use `/plan --refine` or `/implement --refine`.

**Should I clear context between `/plan` and `/implement`?**

Yes. Run `/clear` (or re-open Claude Code) after `/plan` completes and before running `/implement`. The planning phase fills the context with analysis artifacts; a clean context gives implementation agents better results.

## Theoretical Foundation

The SDD plugin is based on established software engineering methodologies and research:

### Core Methodologies

- [GitHub Spec Kit](https://github.com/github/spec-kit) - Specification-driven development templates and workflows
- [OpenSpec](https://github.com/Fission-AI/OpenSpec) - Open specification format for software requirements
- [BMad Method](https://github.com/bmad-code-org/BMAD-METHOD) - Structured approach to breaking down complex features

### Supporting Research

- [Specification-Driven Development](https://en.wikipedia.org/wiki/Design_by_contract) - Design by contract and formal specification approaches
- [Agile Requirements Engineering](https://www.agilealliance.org/agile101/) - User stories, acceptance criteria, and iterative refinement
- [Test-Driven Development](https://www.agilealliance.org/glossary/tdd/) - Writing tests before implementation
- [Clean Architecture](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html) - Separation of concerns and dependency inversion
- [Vertical Slice Architecture](https://jimmybogard.com/vertical-slice-architecture/) - Feature-based organization for incremental delivery
- [Verbalized Sampling](https://arxiv.org/abs/2510.01171) - A training-free prompting strategy for diverse idea generation. It achieves a **2-3x diversity improvement** while maintaining quality. Used for the `create-ideas`, `brainstorm`, and `plan` commands.
- [Solving a Million-Step LLM Task with Zero Errors](https://arxiv.org/abs/2511.09030) - Reliability pattern for LLM-based agents that enables solving complex tasks with zero errors.
- [LLM-as-a-Judge](https://arxiv.org/abs/2306.05685) - Evaluation patterns for grading LLM output.
- [Multi-Agent Debate](https://arxiv.org/abs/2305.14325) - Leveraging multiple perspectives for higher accuracy.
- [Chain-of-Verification](https://arxiv.org/abs/2309.11495) - Reducing hallucinations through verification steps.
- [Tree of Thoughts](https://arxiv.org/abs/2305.10601) - Structured exploration of complex solution spaces.
- [Constitutional AI](https://arxiv.org/abs/2212.08073) - Defining core principles for agent behavior.
- [Chain of Thought Prompting](https://arxiv.org/abs/2201.11903) - Enabling step-by-step reasoning.
- [TICKing All the Boxes](https://arxiv.org/abs/2410.03608) - Checklist decomposition for LLM evaluation and generation.
- [RocketEval](https://arxiv.org/abs/2503.05142) - Efficient automated LLM evaluation via grading checklists (0.986 Spearman).
- [AutoChecklist](https://arxiv.org/abs/2603.07019) - Composable pipelines for checklist generation and scoring.
- [Branch-Solve-Merge](https://arxiv.org/abs/2310.15123) - Decomposed evaluation improving LLM evaluation and generation.
- [InFoBench](https://arxiv.org/abs/2401.03601) - Decomposed requirements following ratio for instruction-following evaluation.
- [Rethinking Rubric Generation](https://arxiv.org/pdf/2602.05125) - Automatic rubric generation for improving LLM judges.
- [LLM-as-a-Meta-Judge](https://arxiv.org/pdf/2407.19594) - Meta-evaluation of LLM judges for quality assurance.
