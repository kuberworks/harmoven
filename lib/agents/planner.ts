// lib/agents/planner.ts
// Planner — decomposes a task into an executable DAG of agent sub-tasks.
// Spec: AGENTS-01-CORE.md Sections 4 and 5.2.
//
// Rules:
// - Always uses the highest-capability LLM tier ("powerful").
// - meta.confidence < 85 → requires_human_approval = true (UI checkpoint shown).
// - Full ClassifierResult context passed to LLM (not just profile id).
// - DAG validated: acyclicity, node id refs, single REVIEWER as last node.
// - Cost estimates clamped to $0–$999.
// - Real LLM wired in T1.9; MockLLMClient used in all unit tests.

import type { ILLMClient } from '@/lib/llm/interface'
import type { ClassifierResult, ProfileId } from '@/lib/agents/classifier'
import { withRetry } from '@/lib/utils/retry'
import { PlannerHandoffSchema } from '@/lib/agents/handoff'
import { parseRunConfig } from '@/lib/execution/run-config'
import { db } from '@/lib/db/client'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PlannerNode {
  node_id: string
  /** Agent role. WRITER executes leaf tasks; REVIEWER is always the final node. PYTHON_EXECUTOR runs Python code. */
  agent: 'WRITER' | 'REVIEWER' | 'QA' | 'DEVOPS' | 'PYTHON_EXECUTOR'
  description: string
  /** node_ids that must reach COMPLETED before this node can start. */
  dependencies: string[]
  llm_strategy: 'dynamic' | 'fast' | 'balanced' | 'powerful'
  complexity: 'low' | 'medium' | 'high'
  timeout_minutes: number
  /** References to outputs of prior nodes, e.g. "output:n1". */
  inputs: string[]
  expected_output_type: string  /** When set, the WRITER node targets this file format (spec §1.5). */
  output_file_format?: string}

export interface PlannerEdge {
  from: string
  to: string
}

export interface PlannerMeta {
  /** 0–100. Below 85 → requires_human_approval. */
  confidence: number
  confidence_rationale: string
  estimated_total_tokens: number
  estimated_cost_usd: number
  estimated_duration_minutes: number
  /** Groups of node_ids that can run in parallel. */
  parallel_branches: string[][]
  human_gate_points: string[]
}

export interface PlannerHandoff {
  handoff_version: string
  source_agent: 'PLANNER'
  target_agent: 'DAG_EXECUTOR'
  run_id: string
  domain_profile: ProfileId
  task_summary: string
  assumptions: string[]
  dag: {
    nodes: PlannerNode[]
    edges: PlannerEdge[]
  }
  meta: PlannerMeta
  /** Derived: true when meta.confidence < 85 → UI shows approval checkpoint. */
  requires_human_approval: boolean
}

// ─── System prompt ────────────────────────────────────────────────────────────

const PLANNER_SYSTEM_PROMPT = `\
You are the Harmoven Planner. Decompose the given task into an executable DAG of agent sub-tasks.
Output ONLY valid JSON matching this schema — no markdown, no prose:

{
  "handoff_version": "1.0",
  "source_agent": "PLANNER",
  "target_agent": "DAG_EXECUTOR",
  "run_id": "<run_id from input>",
  "domain_profile": "<profile id>",
  "task_summary": "<one sentence task summary>",
  "assumptions": ["<assumption 1>"],
  "dag": {
    "nodes": [
      {
        "node_id": "n1",
        "agent": "WRITER",
        "description": "<what this node produces>",
        "dependencies": [],
        "llm_strategy": "dynamic",
        "complexity": "high",
        "timeout_minutes": 20,
        "inputs": [],
        "expected_output_type": "code"
      }
    ],
    "edges": [
      {"from": "n1", "to": "n2"}
    ]
  },
  "meta": {
    "confidence": <integer 0-100>,
    "confidence_rationale": "<brief explanation>",
    "estimated_total_tokens": <integer>,
    "estimated_cost_usd": <float>,
    "estimated_duration_minutes": <integer>,
    "parallel_branches": [],
    "human_gate_points": ["after_reviewer"]
  }
}

Rules:
- VALID "agent" values for dag.nodes: WRITER, PYTHON_EXECUTOR, REVIEWER only.
  PLANNER, CLASSIFIER, and any other value are FORBIDDEN in dag.nodes — if you output
  a node with "agent": "PLANNER" or "agent": "CLASSIFIER" the entire plan is rejected.
  You are the one-and-only Planner; you do NOT recurse or spawn another Planner.
- Use WRITER for prose, text, and code generation — EXCEPT when the task requires
  downloadable binary files (Excel, CSV, PDF, image, etc.): in that case you MUST follow
  the PYTHON_EXECUTOR rule below. NEVER use WRITER to output a JSON description or text
  placeholder for a file; the file must be actually created by PYTHON_EXECUTOR.
- REVIEWER must be the final node (depends on all other leaf nodes).
- dependencies contains node_ids that must complete first.
- If meta.confidence < 85, the plan will require human approval before execution.
- Max lateral delegations: 2.
- CRITICAL: Maximum DAG depth is 6 levels. The longest chain of sequential nodes (longest path from any root node to REVIEWER) must not exceed 6 nodes.
- SCALE WIDTH, NOT DEPTH: for large tasks (e.g. a 20-section document, a 15-module course), create many parallel WRITER nodes at the same depth level — they all depend on PLANNER and are all depended on by REVIEWER. You may have up to 20 parallel WRITER nodes. Do NOT chain writers sequentially unless there is a strict content dependency between them.
- GOOD example for a 10-section course: n1=CLASSIFIER→n2=PLANNER→n3..n12 (10×WRITER, all depend on n2)→n13=REVIEWER (depends on n3..n12). Depth=3, width=10.
- BAD example: n1→n2→n3→n4→n5→n6→n7 (7 sequential nodes). Only do this if each section genuinely requires the previous one as input.

OUTPUT FORMATTING — applies to every WRITER node that generates prose or data (NOT python_code nodes):
- WRITER nodes MUST produce Markdown-formatted content in output.content, like ChatGPT or Claude:
  use # / ## headings, **bold**, lists, fenced code blocks (\`\`\`lang\`\`\`), blockquotes.
- Never produce a wall of plain unstructured text.
- For WRITER nodes that are NOT python_code nodes, set expected_output_type = "document" so the
  UI renders the output as Markdown instead of raw text.

PYTHON_EXECUTOR — two distinct patterns (choose based on the task goal):

PATTERN A — FILE GENERATION (task = "create / produce a downloadable file, no written explanation needed"):
- TRIGGER: request for a spreadsheet, Excel, .xlsx, .xls, CSV, PDF, chart, graph, image,
  PNG, SVG, project scaffold (app skeleton, source code project with multiple files),
  or any file the user can download — and the task does NOT ask for a written explanation,
  analysis, or markdown summary of those files (use PATTERN C in that case).
- CRITICAL — project scaffolding rule: if the user asks to "create a project", "scaffold an app",
  "generate a [Spring Boot / Node / Django / React / ...] project", "create a boilerplate", or any
  request that implies generating multiple source code files → you MUST use PYTHON_EXECUTOR.
  The Python code creates EACH FILE INDIVIDUALLY with open('relative/path/filename.ext', 'w').write(...)
  (using os.makedirs for subdirectories). DO NOT package files into a zip — the platform
  automatically provides a "Download as ZIP" button that bundles all individual files.
  Saving each file individually means the user sees every file listed in the UI and can
  download them one by one or as a zip bundle.
  A WRITER node that just DESCRIBES a project structure in Markdown (without PYTHON_EXECUTOR)
  is STRICTLY FORBIDDEN for this type of request.
- NEVER output a text/JSON description of what a file should contain; the file must be created
  by Python code. A WRITER saying "here is the Excel content" with no PYTHON_EXECUTOR is WRONG.
- WRITER nodes produce ONLY raw Python source code (no prose, no Markdown fences);
  PYTHON_EXECUTOR runs all that code in a sandboxed Pyodide environment;
  files saved to disk are automatically collected and made downloadable.
- Python code MUST write files with workbook.save('name.xlsx'), df.to_csv('name.csv'),
  plt.savefig('name.png'), or open('name.ext', 'wb').write(...).
  File names: alphanumeric + dots/hyphens. For project files, use the natural filename
  (e.g. 'pom.xml', 'Application.java', 'application.properties').
- NEVER use zipfile.ZipFile for project scaffolds — individual files only.
  (zipfile is only acceptable for non-project tasks like archiving binary assets.)
- WRITER nodes feeding PYTHON_EXECUTOR: expected_output_type = "python_code".
- PYTHON_EXECUTOR node: expected_output_type = "python_files", complexity = "medium".
- Chain: {WRITER(s)} → PYTHON_EXECUTOR → REVIEWER.
- GOOD example — single file:
  n3=WRITER(python_code) → n4=PYTHON_EXECUTOR → n5=REVIEWER. Depth=4.
- GOOD example — multi-sheet Excel:
  n3=WRITER(sheet 1 code) + n4=WRITER(sheet 2 code) → n5=PYTHON_EXECUTOR → n6=REVIEWER.
- GOOD example — Spring Boot / Maven project scaffold (individual files):
  n3=WRITER(python_code: uses os.makedirs to create directory tree, then open().write()
    for each individual file — pom.xml, src/main/java/.../Application.java,
    src/main/java/.../HelloController.java, src/main/resources/application.properties,
    README.md — all saved individually; prints a summary listing every file to stdout)
  → n4=PYTHON_EXECUTOR
  → n5=REVIEWER. Depth=4.
  SAME pattern applies to any project scaffold: Node.js, Django, React, etc.
- BAD (FORBIDDEN): WRITER outputs JSON describing file contents with no PYTHON_EXECUTOR.
- BAD (FORBIDDEN): WRITER writes a Markdown README describing a project structure with no
  PYTHON_EXECUTOR — this gives the user zero downloadable files.
- BAD (FORBIDDEN): WRITER creates a zip archive instead of individual files for a project scaffold.

PATTERN B — DATA ANALYSIS (task = "read / inspect / analyze / summarize an existing file"):
- TRIGGER: task asks to analyze, inspect, describe, explain, summarize, explore, or report
  on the contents of an uploaded file (Excel, CSV, JSON, text, etc.) — the goal is a
  human-readable document, NOT a new downloadable file.
- You MUST use a final WRITER(document) node after PYTHON_EXECUTOR to turn the Python
  output (stdout) into a structured Markdown report. NEVER send PYTHON_EXECUTOR output
  directly to REVIEWER — it only contains raw stdout/stderr, not a formatted document.
- Pattern:
  WRITER(python_code, reads file and prints findings as text/JSON to stdout)
    → PYTHON_EXECUTOR (runs the code; stdout = analysis data)
    → WRITER(document, expected_output_type="document", receives stdout, writes Markdown report)
    → REVIEWER.
- The python_code WRITER must print all findings to stdout (print(), not file.write()).
  It must NOT save any file to disk — its only output is stdout.
- The document WRITER receives { stdout: "...", exit_code: 0, ... } as upstream_inputs;
  it must synthesise that data into a well-structured Markdown document.
- GOOD example — analyze Excel contents:
  n3=WRITER(python_code: reads file, prints sheet names, column headers, row counts, sample rows)
  → n4=PYTHON_EXECUTOR
  → n5=WRITER(document: synthesises stdout into ## Sheets / ## Columns / ## Data sample Markdown)
  → n6=REVIEWER. Depth=5.
- BAD (FORBIDDEN): n3=WRITER(python_code) → n4=PYTHON_EXECUTOR → n5=REVIEWER.
  The REVIEWER receives raw stdout and has no WriterOutput to review → broken output.

PATTERN C — FILE GENERATION + MARKDOWN REPORT (task = "create files AND explain / document them"):
- TRIGGER: task asks to generate downloadable files (Excel, CSV, PDF, image, zip project, etc.) AND also
  produce a written explanation, summary, methodology, or documentation of what was created.
  Examples: "create a sales dashboard Excel + write an analysis report",
  "generate the graphs and write a summary of the results",
  "build the dataset and provide documentation on its structure",
  "scaffold a Spring Boot project and explain each file",
  "create a React app boilerplate and document the architecture".
- NEVER use PATTERN A when the user also wants a written document — it skips the explanation.
- NEVER use PATTERN B (which reads an existing file) when the task is to CREATE new files.
- Pattern:
  WRITER(python_code, creates files AND prints a summary of what was created to stdout)
    → PYTHON_EXECUTOR (runs the code; files are collected; stdout = creation summary)
    → WRITER(document, expected_output_type="document", receives stdout + file listing,
              writes a Markdown document explaining the generated files, methodology,
              key findings or structure, and how to use/interpret each file)
    → REVIEWER.
- The python_code WRITER MUST:
  1. Save all files to disk (workbook.save('...'), df.to_csv('...'), plt.savefig('...'), etc.)
  2. Also print a structured summary to stdout describing each file created, key stats,
     or any computed values — this becomes the input for the document WRITER.
- The document WRITER receives { stdout: "...", files: [...] } as upstream_inputs;
  it must produce a structured Markdown document with headings, tables, and explanations.
- GOOD example — generate Excel budget + write analysis:
  n3=WRITER(python_code: creates budget.xlsx, prints sheet names + key totals to stdout)
  → n4=PYTHON_EXECUTOR
  → n5=WRITER(document: summarises budget structure and key figures in Markdown)
  → n6=REVIEWER. Depth=5.
- GOOD example — generate multiple charts + summary report:
  n3=WRITER(python_code: creates chart1.png + chart2.png, prints axis labels and insights)
  → n4=PYTHON_EXECUTOR
  → n5=WRITER(document: describes what each chart shows, methodology, conclusions)
  → n6=REVIEWER. Depth=5.
- GOOD example — scaffold a project + explain it:
  n3=WRITER(python_code: creates ALL project files individually with open().write() —
    pom.xml, Application.java, HelloController.java, application.properties, README.md, etc.
    Never creates a zip. Prints a list of created files + architecture summary to stdout)
  → n4=PYTHON_EXECUTOR
  → n5=WRITER(document: synthesises stdout into a Markdown README explaining the
    project structure, each file's purpose, and how to run/deploy the app)
  → n6=REVIEWER. Depth=5.
- BAD (FORBIDDEN): use PATTERN A (no document WRITER) when the user explicitly wants a report.
- BAD (FORBIDDEN): use PATTERN B (reads existing file) when creating new files from scratch.

FORMAT ROUTING:
If the classifier input contains desired_outputs:
- For each entry with produced_by = "writer": set output_file_format on the corresponding
  WRITER node config (use the format value exactly as-is, e.g. "csv", "json", "md").
- For each entry with produced_by = "python": ensure a PYTHON_EXECUTOR node is present
  after the WRITER(python_code) node.

PROFILE ROUTING (override rules based on classifier detected_profile):
- app_scaffolding: the user wants to CREATE a runnable app, project, or codebase.
  ALWAYS use PYTHON_EXECUTOR (PATTERN A or C). A WRITER-only plan is WRONG for this profile.
  The Python code MUST save each source file individually — NEVER create a zip.
  The platform provides a built-in "Download as ZIP" button that bundles all individual files.
  NEVER produce a Markdown description of what the project would look like — that is NOT a project.

OUTPUT FILE FORMAT PRIORITY (C2 rule):
If run_config.output_file_format is set (the user selected a format in the UI form),
it ALWAYS takes priority over desired_outputs from the CLASSIFIER.
Use run_config.output_file_format for ALL WRITER nodes when it is present.`

// ─── DAG validation ───────────────────────────────────────────────────────────

function validateDag(dag: PlannerHandoff['dag']): void {
  const nodeIds = new Set(dag.nodes.map(n => n.node_id))

  // All edge endpoints must reference known nodes
  for (const edge of dag.edges) {
    if (!nodeIds.has(edge.from)) throw new Error(`Planner: edge references unknown node "${edge.from}"`)
    if (!nodeIds.has(edge.to))   throw new Error(`Planner: edge references unknown node "${edge.to}"`)
  }

  // All dependency refs must reference known nodes
  for (const node of dag.nodes) {
    for (const dep of node.dependencies) {
      if (!nodeIds.has(dep)) throw new Error(`Planner: node "${node.node_id}" depends on unknown "${dep}"`)
    }
  }

  // Cycle detection via Kahn's algorithm
  const inDegree = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const id of nodeIds) { inDegree.set(id, 0); adj.set(id, []) }
  for (const edge of dag.edges) {
    adj.get(edge.from)!.push(edge.to)
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1)
  }
  const queue = [...nodeIds].filter(id => inDegree.get(id) === 0)
  let visited = 0
  while (queue.length > 0) {
    const curr = queue.shift()!
    visited++
    for (const next of adj.get(curr) ?? []) {
      const deg = (inDegree.get(next) ?? 0) - 1
      inDegree.set(next, deg)
      if (deg === 0) queue.push(next)
    }
  }
  if (visited !== nodeIds.size) throw new Error('Planner: DAG contains a cycle')

  // Exactly one REVIEWER node must exist and have no successors
  const reviewerNodes = dag.nodes.filter(n => n.agent === 'REVIEWER')
  if (reviewerNodes.length === 0) throw new Error('Planner: DAG must contain exactly one REVIEWER node')
  if (reviewerNodes.length > 1)  throw new Error('Planner: DAG contains more than one REVIEWER node')
  const reviewerNode = reviewerNodes[0]
  if (!reviewerNode) throw new Error('Planner: DAG must contain exactly one REVIEWER node')
  const reviewerId = reviewerNode.node_id
  const hasSuccessor = dag.edges.some(e => e.from === reviewerId)
  if (hasSuccessor) throw new Error('Planner: REVIEWER node must be the final node (no outgoing edges)')

  // Depth check: longest path must not exceed 6 levels (spec §lib/dag/validate.ts).
  // Recompute in-degree from scratch (the Kahn queue above is already consumed).
  const MAX_DAG_DEPTH = 6
  const depthInDeg = new Map<string, number>()
  const depthAdj  = new Map<string, string[]>()
  for (const id of nodeIds) { depthInDeg.set(id, 0); depthAdj.set(id, []) }
  for (const edge of dag.edges) {
    depthAdj.get(edge.from)!.push(edge.to)
    depthInDeg.set(edge.to, (depthInDeg.get(edge.to) ?? 0) + 1)
  }
  // BFS from all roots, tracking depth of each node.
  const depth = new Map<string, number>()
  const depthQueue = [...nodeIds].filter(id => depthInDeg.get(id) === 0)
  for (const root of depthQueue) depth.set(root, 0)
  const bfsQueue = [...depthQueue]
  while (bfsQueue.length > 0) {
    const curr = bfsQueue.shift()!
    const currDepth = depth.get(curr) ?? 0
    for (const next of depthAdj.get(curr) ?? []) {
      const nextDepth = Math.max(depth.get(next) ?? 0, currDepth + 1)
      depth.set(next, nextDepth)
      bfsQueue.push(next)
    }
  }
  const maxDepth = Math.max(0, ...[...depth.values()])
  if (maxDepth > MAX_DAG_DEPTH) {
    throw new Error(`Planner: DAG depth ${maxDepth} exceeds maximum allowed depth of ${MAX_DAG_DEPTH}`)
  }
}

// ─── Planner exhaustion error ────────────────────────────────────────────────

/**
 * Thrown when the Planner fails validation 3 times in a row.
 * The caller (executor) should open a HumanGate instead of failing the run.
 */
export class PlannerExhaustionError extends Error {
  constructor(
    public readonly attempts: number,
    public readonly lastError: unknown,
  ) {
    super(
      `Planner: DAG validation failed after ${attempts} attempt${
        attempts === 1 ? '' : 's'
      } — opening human gate for operator review`,
    )
    this.name = 'PlannerExhaustionError'
  }
}

// ─── Planner ─────────────────────────────────────────────────────────────────

export class Planner {
  constructor(private readonly llm: ILLMClient) {}

  async plan(
    task_input: string,
    profile: ClassifierResult,
    run_id: string,
    signal?: AbortSignal,
    prior_context?: string,
  ): Promise<PlannerHandoff> {
    // Outer loop: retry the full LLM + validation cycle up to 3 times on
    // *validation* failures. withRetry() inside already handles LLM-level
    // transient errors (network, rate-limit, 5xx) without counting them here.
    // Spec: "Planner retry: max 3 re-runs on validation failure → Human Gate"
    const MAX_VALIDATION_ATTEMPTS = 3
    let lastErr: unknown

    for (let attempt = 1; attempt <= MAX_VALIDATION_ATTEMPTS; attempt++) {
      try {
        const result = await withRetry(
          () => this.llm.chat(
            [
              { role: 'system', content: PLANNER_SYSTEM_PROMPT },
              {
                role: 'user',
                content: JSON.stringify({
                  task: task_input,
                  run_id,
                  // Outputs from the parent run (populated for spawned follow-up runs only).
                  // The Planner must reference these artefacts when building the child DAG
                  // instead of re-generating what was already produced.
                  ...(prior_context ? { prior_run_context: prior_context } : {}),
                  // Full classifier context — not just profile id
                  classifier: {
                    domain_profile:          profile.detected_profile,
                    domain:                  profile.domain,
                    output_type:             profile.output_type,
                    confidence:              profile.confidence,
                    input_summary:           profile.input_summary,
                    clarification_questions: profile.clarification_questions,
                    // Pass desired_outputs so the LLM can set output_file_format on nodes
                    ...(profile.desired_outputs?.length
                      ? { desired_outputs: profile.desired_outputs }
                      : {}),
                  },
                }),
              },
            ],
            { model: 'powerful', signal },
          ),
          {
            signal,
            onRetry: (err, llmAttempt) =>
              console.warn(`[Planner] LLM attempt ${llmAttempt} failed (validation attempt ${attempt}):`, err),
          },
        )

        let parsed: unknown
        const content = result.content ?? ''
        try {
          let raw = content
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```\s*$/, '')
            .trim()
          try {
            parsed = JSON.parse(raw)
          } catch {
            const match = raw.match(/\{[\s\S]*\}/)
            if (!match || match[0] == null) throw new Error('no JSON object found in response')
            parsed = JSON.parse(match[0])
          }
        } catch {
          throw new Error(
            `Planner: LLM returned invalid JSON — ${content.slice(0, 300)}`,
          )
        }

        const raw = parsed as Record<string, unknown>
        const meta = raw['meta'] as Record<string, unknown> | undefined
        if (typeof meta?.['confidence'] !== 'number') {
          throw new Error('Planner: missing or invalid "meta.confidence" field in LLM response')
        }

        const confidence = meta['confidence'] as number
        if (confidence < 0 || confidence > 100) {
          throw new Error('Planner: meta.confidence must be 0–100')
        }

        // Clamp cost estimate to sane range ($0–$999)
        if (typeof meta['estimated_cost_usd'] === 'number') {
          meta['estimated_cost_usd'] = Math.min(Math.max(0, meta['estimated_cost_usd']), 999)
        }

        const dag = raw['dag'] as PlannerHandoff['dag']
        validateDag(dag)

        // Full Zod schema validation — catches invalid agent types (e.g. "PLANNER"),
        // bad enum values, missing required fields. Must run AFTER validateDag so that
        // structural errors (cycles, missing refs) produce better error messages.
        const zodResult = PlannerHandoffSchema.safeParse({
          ...raw,
          requires_human_approval: confidence < 85,
        })
        if (!zodResult.success) {
          throw new Error(
            `Planner: schema validation failed — ${zodResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ')}`,
          )
        }

        // ── C2 rule: output_file_format post-processing ─────────────────────
        // After DAG validation, apply format overrides:
        //   1. run_config.output_file_format (form selector) takes ABSOLUTE priority
        //   2. Fallback: desired_outputs from classifier
        const plannerResult = zodResult.data
        const runRow = await db.run.findUnique({ where: { id: run_id }, select: { run_config: true } }).catch(() => null)
        const runConfig = parseRunConfig(runRow?.run_config ?? {})

        if (runConfig.output_file_format) {
          // C2: override output_file_format on ALL WRITER nodes
          for (const n of plannerResult.dag.nodes) {
            if (n.agent === 'WRITER') {
              (n as Record<string, unknown>)['output_file_format'] = runConfig.output_file_format
            }
          }
        } else if (profile.desired_outputs?.length) {
          // Propagate desired_outputs to WRITER nodes (one entry per WRITER in sequence)
          const writerNodes = plannerResult.dag.nodes.filter(n => n.agent === 'WRITER')
          const writerDesired = profile.desired_outputs.filter(d => d.produced_by === 'writer')
          for (let i = 0; i < Math.min(writerNodes.length, writerDesired.length); i++) {
            const w = writerNodes[i]!
            const d = writerDesired[i]!
            if (!w.output_file_format) {
              // Only set if the LLM didn't already set it
              ;(w as Record<string, unknown>)['output_file_format'] = d.format
            }
          }
        }

        return plannerResult
      } catch (err) {
        // Never retry on abort — it's an intentional cancellation.
        if (err instanceof DOMException && err.name === 'AbortError') throw err
        lastErr = err
        console.warn(
          `[Planner] validation attempt ${attempt}/${MAX_VALIDATION_ATTEMPTS} failed:`,
          err instanceof Error ? err.message : err,
        )
      }
    }

    // All validation attempts exhausted — escalate to human gate.
    throw new PlannerExhaustionError(MAX_VALIDATION_ATTEMPTS, lastErr)
  }
}
