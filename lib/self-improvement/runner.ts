// lib/self-improvement/runner.ts
// Orchestrates one full self-improvement cycle:
//   1. Read config + check Docker gate
//   2. computeInstanceMetrics()
//   3. generateSuggestions()
//   4. Upsert suggestions to DB (skip dismissed/applied)
//   5. Purge expired suggestions

import { db }                      from '@/lib/db/client'
import { readSelfImprovementConfig, isDockerDeployment } from './config'
import { computeInstanceMetrics }  from './analyzer'
import { generateSuggestions }     from './suggestions'

export async function runSelfImprovementCycle(): Promise<void> {
  if (!isDockerDeployment()) return

  const cfg = readSelfImprovementConfig()
  if (!cfg.enabled) return

  const metrics     = await computeInstanceMetrics(cfg)
  const suggestions = generateSuggestions(metrics, cfg)

  let upserted = 0
  for (const s of suggestions) {
    // Never re-open a dismissed or already-applied suggestion
    const existing = await db.improvementSuggestion.findUnique({
      where:  { cycle_key: s.cycle_key },
      select: { status: true },
    })
    if (existing?.status === 'dismissed' || existing?.status === 'applied') continue

    await db.improvementSuggestion.upsert({
      where:  { cycle_key: s.cycle_key },
      create: {
        type:        s.type,
        severity:    s.severity,
        title:       s.title,
        body:        s.body,
        evidence:    s.evidence as object,
        target_id:   s.target_id  ?? null,
        target_type: s.target_type ?? null,
        cycle_key:   s.cycle_key,
        expires_at:  s.expires_at,
      },
      update: {
        severity:    s.severity,
        body:        s.body,
        evidence:    s.evidence as object,
        generated_at: new Date(),
        expires_at:  s.expires_at,
      },
    })
    upserted++
  }

  // Purge expired non-open suggestions
  await db.improvementSuggestion.deleteMany({
    where: {
      expires_at: { lt: new Date() },
      status:     { not: 'open' },
    },
  })

  console.log(`[self-improvement] cycle complete: ${upserted} suggestions upserted`)
}
