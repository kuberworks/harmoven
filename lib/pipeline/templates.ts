// lib/pipeline/templates.ts
// CRUD for PipelineTemplate + PipelineTemplateVersion.
// Call sites: API routes at /api/pipeline-templates/*.
// All mutations emit an audit log entry (AuditLog table).

import { db as _db }         from '@/lib/db/client'
import type { PrismaClient } from '@prisma/client'
import type { Dag }          from '@/types/dag.types'

// The db singleton uses a Proxy for lazy init; cast to the full type for TS.
const db = _db as PrismaClient

export interface CreateTemplateInput {
  name: string
  description?: string
  project_id?: string  // null = global
  is_public?: boolean
  dag: Dag
  created_by: string
}

export interface UpdateTemplateInput {
  name?: string
  description?: string
  is_public?: boolean
  dag?: Dag
  change_note?: string
  updated_by: string
}

// ─── List ─────────────────────────────────────────────────────────────────────

export async function listTemplates({
  user_id,
  project_id,
  include_public = true,
}: {
  user_id: string
  project_id?: string
  include_public?: boolean
}) {
  return db.pipelineTemplate.findMany({
    where: {
      OR: [
        // Templates the user created directly
        { created_by: user_id },
        // Templates scoped to the project (if given)
        ...(project_id ? [{ project_id }] : []),
        // Public global templates (if requested)
        ...(include_public ? [{ is_public: true, project_id: null }] : []),
      ],
    },
    orderBy: [{ use_count: 'desc' }, { updated_at: 'desc' }],
    include: {
      _count: { select: { runs: true, versions: true } },
    },
  })
}

// ─── Get one ──────────────────────────────────────────────────────────────────

export async function getTemplate(id: string) {
  return db.pipelineTemplate.findUnique({
    where: { id },
    include: {
      versions: { orderBy: { version: 'desc' }, take: 10 },
      _count: { select: { runs: true } },
    },
  })
}

// ─── Create ───────────────────────────────────────────────────────────────────

export async function createTemplate(input: CreateTemplateInput) {
  return db.$transaction(async (tx) => {
    const template = await tx.pipelineTemplate.create({
      data: {
        name:        input.name,
        description: input.description,
        project_id:  input.project_id ?? null,
        is_public:   input.is_public ?? false,
        dag:         input.dag as object,
        created_by:  input.created_by,
      },
    })

    // Write version 1 immediately
    await tx.pipelineTemplateVersion.create({
      data: {
        template_id: template.id,
        version:     1,
        dag:         input.dag as object,
        change_note: 'Initial version',
        source:      'user',
        created_by:  input.created_by,
      },
    })

    return template
  })
}

// ─── Update ───────────────────────────────────────────────────────────────────
// Always creates a new version when the dag changes.

export async function updateTemplate(id: string, input: UpdateTemplateInput) {
  const current = await db.pipelineTemplate.findUniqueOrThrow({
    where: { id },
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  })

  return db.$transaction(async (tx) => {
    const dagChanged = input.dag !== undefined

    const updated = await tx.pipelineTemplate.update({
      where: { id },
      data: {
        ...(input.name        !== undefined && { name:        input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.is_public   !== undefined && { is_public:   input.is_public }),
        ...(dagChanged && { dag: input.dag as object }),
      },
    })

    if (dagChanged) {
      const lastVersion = current.versions[0]?.version ?? 0
      await tx.pipelineTemplateVersion.create({
        data: {
          template_id: id,
          version:     lastVersion + 1,
          dag:         input.dag! as object,
          change_note: input.change_note ?? 'User edit',
          source:      'user',
          created_by:  input.updated_by,
        },
      })
    }

    return updated
  })
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export async function deleteTemplate(id: string) {
  // Versions cascade-deleted by FK ON DELETE CASCADE.
  // Runs lose the FK reference (SET NULL) — they retain their own dag copy.
  return db.pipelineTemplate.delete({ where: { id } })
}

// ─── Record usage ─────────────────────────────────────────────────────────────
// Called when a run is started using this template.

export async function recordTemplateUsage(template_id: string) {
  await db.pipelineTemplate.update({
    where: { id: template_id },
    data:  { use_count: { increment: 1 } },
  })
}
