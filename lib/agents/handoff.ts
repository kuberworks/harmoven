// lib/agents/handoff.ts
// Centralised Zod schemas for all inter-agent handoff payloads.
// Spec: TECHNICAL.md L.84 "schema validation (Zod)".
//
// Every handoff written to the Handoff table MUST be validated through one of
// these schemas before persistence. This prevents malformed handoffs from
// silently corrupting downstream agents.
//
// Usage:
//   import { WriterOutputSchema, PlannerHandoffSchema } from '@/lib/agents/handoff'
//   const parsed = WriterOutputSchema.safeParse(rawPayload)

import { z } from 'zod'

// ─── Shared primitives ────────────────────────────────────────────────────────

const ProfileId = z.enum([
  'data_reporting', 'app_scaffolding', 'document_drafting', 'research_synthesis',
  'marketing_content', 'hr_recruiting', 'legal_compliance', 'finance_modeling',
  'customer_support', 'ecommerce_ops', 'training_content', 'generic',
])

const Complexity = z.enum(['low', 'medium', 'high'])

// ─── Classifier → Planner ────────────────────────────────────────────────────

export const ClassifierHandoffSchema = z.object({
  classifier_version:      z.literal('1.0'),
  input_summary:           z.string(),
  detected_profile:        ProfileId,
  output_type:             z.enum(['document', 'code', 'data', 'media', 'action']),
  domain:                  z.string(),
  confidence:              z.number().int().min(0).max(100),
  confidence_rationale:    z.string(),
  clarification_questions: z.array(z.string()).max(3),
  fallback_profile:        ProfileId,
  user_confirmation_text:  z.string(),
  requires_clarification:  z.boolean(),
})

export type ClassifierHandoff = z.infer<typeof ClassifierHandoffSchema>

// ─── Planner → DAG_EXECUTOR ──────────────────────────────────────────────────

const PlannerNodeSchema = z.object({
  node_id:              z.string(),
  agent:                z.enum(['WRITER', 'REVIEWER', 'QA', 'DEVOPS']),
  description:          z.string(),
  dependencies:         z.array(z.string()),
  llm_strategy:         z.enum(['dynamic', 'fast', 'balanced', 'powerful']),
  complexity:           Complexity,
  timeout_minutes:      z.number().positive(),
  inputs:               z.array(z.string()),
  expected_output_type: z.string(),
})

const PlannerMetaSchema = z.object({
  confidence:                  z.number().int().min(0).max(100),
  confidence_rationale:        z.string(),
  estimated_total_tokens:      z.number().nonnegative(),
  estimated_cost_usd:          z.number().min(0).max(999),
  estimated_duration_minutes:  z.number().nonnegative(),
  parallel_branches:           z.array(z.array(z.string())),
  human_gate_points:           z.array(z.string()),
})

export const PlannerHandoffSchema = z.object({
  handoff_version:        z.literal('1.0'),
  source_agent:           z.literal('PLANNER'),
  target_agent:           z.literal('DAG_EXECUTOR'),
  run_id:                 z.string(),
  domain_profile:         ProfileId,
  task_summary:           z.string(),
  assumptions:            z.array(z.string()),
  dag: z.object({
    nodes: z.array(PlannerNodeSchema),
    edges: z.array(z.object({ from: z.string(), to: z.string() })),
  }),
  meta:                   PlannerMetaSchema,
  requires_human_approval: z.boolean(),
})

export type PlannerHandoff = z.infer<typeof PlannerHandoffSchema>

// ─── Writer → Reviewer ───────────────────────────────────────────────────────

export const WriterHandoffSchema = z.object({
  handoff_version:  z.literal('1.0'),
  source_agent:     z.literal('WRITER'),
  source_node_id:   z.string(),
  target_agent:     z.literal('REVIEWER'),
  run_id:           z.string(),
  output: z.object({
    type:                  z.string(),
    summary:               z.string(),
    content:               z.string(),
    confidence:            z.number().int().min(0).max(100),
    confidence_rationale:  z.string(),
  }),
  assumptions_made: z.array(z.string()),
  execution_meta: z.object({
    llm_used:        z.string(),
    tokens_input:    z.number().nonnegative(),
    tokens_output:   z.number().nonnegative(),
    duration_seconds: z.number().nonnegative(),
    retries:         z.number().nonnegative(),
  }),
  lateral_delegation_request: z.null(),
})

export type WriterHandoff = z.infer<typeof WriterHandoffSchema>

// ─── Reviewer → Human Gate ───────────────────────────────────────────────────

export const ReviewerHandoffSchema = z.object({
  handoff_version:              z.literal('1.0'),
  source_agent:                 z.literal('REVIEWER'),
  target:                       z.literal('HUMAN_GATE'),
  run_id:                       z.string(),
  verdict:                      z.enum(['APPROVE', 'REQUEST_REVISION', 'ESCALATE_HUMAN']),
  findings: z.array(z.object({
    severity:        z.enum(['info', 'warning', 'error']),
    node_id:         z.string(),
    issue:           z.string(),
    recommendation:  z.string(),
  })),
  overall_confidence:           z.number().int().min(0).max(100),
  overall_confidence_rationale: z.string(),
  formatted_content:            z.string().optional(),
  meta: z.object({
    llm_used:         z.string(),
    tokens_input:     z.number().nonnegative(),
    tokens_output:    z.number().nonnegative(),
    duration_seconds: z.number().nonnegative(),
  }),
})

export type ReviewerHandoff = z.infer<typeof ReviewerHandoffSchema>
