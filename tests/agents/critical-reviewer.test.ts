// tests/agents/critical-reviewer.test.ts
// Unit tests for CriticalReviewer: severity resolution, output parsing,
// max-findings cap, disabled (severity=0), targeted fix budget cap.
// All LLM calls are mocked via MockLLMClient.

import { jest } from '@jest/globals'
import { CriticalReviewer } from '@/lib/agents/critical-reviewer'
import {
  resolveCriticalSeverity,
  CRITICAL_SEVERITY_DEFAULTS,
  PRESET_SEVERITY,
} from '@/lib/agents/reviewer/critical-reviewer.types'
import type { CriticalFinding } from '@/lib/agents/reviewer/critical-reviewer.types'
import { MockLLMClient } from '@/lib/llm/mock-client'
import type { WriterOutput } from '@/lib/agents/writer'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFinding(overrides: Partial<CriticalFinding> = {}): CriticalFinding {
  return {
    id:          'f-001',
    severity:    'important',
    title:       'Example finding',
    observation: 'Something is wrong.',
    impact:      'Production could fail.',
    suggestion:  'Fix it.',
    domain:      'security',
    ...overrides,
  }
}

function makeWriterOutput(partial: Partial<WriterOutput> = {}): WriterOutput {
  return {
    handoff_version: '1.0',
    source_agent: 'WRITER',
    source_node_id: 'n1',
    run_id: 'run-001',
    output: {
      type: 'document',
      summary: 'A document',
      content: 'Content',
      confidence: 80,
    },
    assumptions_made: [],
    ...partial,
  } as WriterOutput
}

function makeReviewJson(
  verdict: 'no_issues' | 'issues_found',
  findings: CriticalFinding[],
  suppressed = 0,
  rationale = 'All good.',
) {
  return JSON.stringify({ verdict, severity: 2, findings, suppressed, rationale })
}

// ─── resolveCriticalSeverity ──────────────────────────────────────────────────

describe('resolveCriticalSeverity', () => {
  it('uses run_config_severity as highest priority', () => {
    expect(resolveCriticalSeverity({
      runConfigSeverity: 4,
      projectSeverity:   2,
      preset:            'non_tech_guided',
      domainProfile:     'medical_support',
    })).toBe(4)
  })

  it('falls through to project severity when run_config is absent', () => {
    expect(resolveCriticalSeverity({
      runConfigSeverity: null,
      projectSeverity:   3,
      preset:            'non_tech_guided',
      domainProfile:     'medical_support',
    })).toBe(3)
  })

  it('uses preset bake-in when project severity is absent', () => {
    expect(resolveCriticalSeverity({
      runConfigSeverity: null,
      projectSeverity:   null,
      preset:            'dev_senior',
      domainProfile:     'data_reporting',
    })).toBe(PRESET_SEVERITY['dev_senior']) // 3
  })

  it('uses domain default when preset is absent', () => {
    expect(resolveCriticalSeverity({
      domainProfile: 'legal_compliance',
    })).toBe(CRITICAL_SEVERITY_DEFAULTS['legal_compliance']) // 4
  })

  it('falls back to 2 when nothing is specified', () => {
    expect(resolveCriticalSeverity({})).toBe(2)
  })

  it('clamps out-of-range values to [0, 5]', () => {
    expect(resolveCriticalSeverity({ runConfigSeverity: 99 })).toBe(5)
    expect(resolveCriticalSeverity({ runConfigSeverity: -1 })).toBe(0)
  })

  it('medical_support defaults to 5 (paranoid)', () => {
    expect(resolveCriticalSeverity({ domainProfile: 'medical_support' })).toBe(5)
  })

  it('document_drafting defaults to 1 (lenient)', () => {
    expect(resolveCriticalSeverity({ domainProfile: 'document_drafting' })).toBe(1)
  })
})

// ─── CriticalReviewer — severity=0 (disabled) ────────────────────────────────

describe('CriticalReviewer — severity 0', () => {
  it('returns no_issues without calling LLM', async () => {
    const llm = new MockLLMClient()
    llm.setNextResponse('{"verdict":"issues_found","findings":[]}')
    const chatSpy = jest.spyOn(llm, 'chat')

    const reviewer = new CriticalReviewer(llm)
    const result = await reviewer.review([], 0, 'run-001')

    expect(result.verdict).toBe('no_issues')
    expect(result.findings).toHaveLength(0)
    expect(result.severity).toBe(0)
    expect(result.meta.llm_used).toBe('none')
    expect(chatSpy).not.toHaveBeenCalled()
  })
})

// ─── CriticalReviewer — max 3 findings cap ───────────────────────────────────

describe('CriticalReviewer — MAX 3 findings cap', () => {
  it('truncates LLM output that returns more than 3 findings', async () => {
    const findings = [1, 2, 3, 4, 5].map(i => makeFinding({ id: `f-${i}`, title: `Finding ${i}` }))
    const llm = new MockLLMClient()
    llm.setNextResponse(makeReviewJson('issues_found', findings, 0, 'Too many'))
    const reviewer = new CriticalReviewer(llm)

    const result = await reviewer.review([makeWriterOutput()], 2, 'run-001')

    expect(result.findings).toHaveLength(3) // capped at MAX=3
    expect(result.findings[0]!.title).toBe('Finding 1')
    expect(result.findings[2]!.title).toBe('Finding 3')
  })
})

// ─── CriticalReviewer — verdict parsing ──────────────────────────────────────

describe('CriticalReviewer — verdict parsing', () => {
  it('returns no_issues verdict', async () => {
    const llm = new MockLLMClient()
    llm.setNextResponse(makeReviewJson('no_issues', [], 2, 'Nothing critical.'))
    const reviewer = new CriticalReviewer(llm)
    const result = await reviewer.review([makeWriterOutput()], 2, 'run-001')

    expect(result.verdict).toBe('no_issues')
    expect(result.findings).toHaveLength(0)
    expect(result.suppressed).toBe(2)
    expect(result.rationale).toBe('Nothing critical.')
  })

  it('returns issues_found with findings', async () => {
    const f1 = makeFinding({ id: 'f-1', severity: 'blocking', title: 'Auth missing' })
    const f2 = makeFinding({ id: 'f-2', severity: 'watch',    title: 'Unused dep'   })
    const llm = new MockLLMClient()
    llm.setNextResponse(makeReviewJson('issues_found', [f1, f2], 0, 'Two findings.'))
    const reviewer = new CriticalReviewer(llm)
    const result = await reviewer.review([makeWriterOutput()], 3, 'run-001')

    expect(result.verdict).toBe('issues_found')
    expect(result.findings).toHaveLength(2)
    expect(result.findings[0]!.severity).toBe('blocking')
    expect(result.findings[1]!.severity).toBe('watch')
  })

  it('throws on invalid JSON from LLM', async () => {
    const llm = new MockLLMClient()
    llm.setNextResponse('not json at all')
    const reviewer = new CriticalReviewer(llm)

    await expect(reviewer.review([makeWriterOutput()], 2, 'run-001'))
      .rejects.toThrow('Invalid JSON from LLM')
  })

  it('throws on invalid verdict value', async () => {
    const llm = new MockLLMClient()
    llm.setNextResponse('{"verdict":"WRONG","findings":[],"suppressed":0,"rationale":""}')
    const reviewer = new CriticalReviewer(llm)

    await expect(reviewer.review([makeWriterOutput()], 2, 'run-001'))
      .rejects.toThrow('Invalid verdict')
  })

  it('handles markdown-fenced JSON response', async () => {
    const raw = '```json\n' + makeReviewJson('no_issues', [], 0, 'Clean.') + '\n```'
    const llm = new MockLLMClient()
    llm.setNextResponse(raw)
    const reviewer = new CriticalReviewer(llm)
    const result = await reviewer.review([makeWriterOutput()], 1, 'run-001')

    expect(result.verdict).toBe('no_issues')
  })
})

// ─── CriticalReviewer — finding field defaults ────────────────────────────────

describe('CriticalReviewer — finding field defaults', () => {
  it('normalises unknown severity to "watch"', async () => {
    const badFinding = { id: 'f-1', severity: 'CRITICAL_HIGH', title: 'T', observation: 'O', impact: 'I', suggestion: null, domain: 'security' }
    const llm = new MockLLMClient()
    llm.setNextResponse(JSON.stringify({
      verdict: 'issues_found', severity: 2, findings: [badFinding], suppressed: 0, rationale: '',
    }))
    const reviewer = new CriticalReviewer(llm)
    const result = await reviewer.review([makeWriterOutput()], 2, 'run-001')

    expect(result.findings[0]!.severity).toBe('watch')
  })

  it('assigns "finding-0" id when finding.id is missing', async () => {
    const badFinding = { severity: 'important', title: 'T', observation: 'O', impact: 'I', suggestion: null, domain: 'security' }
    const llm = new MockLLMClient()
    llm.setNextResponse(JSON.stringify({
      verdict: 'issues_found', severity: 2, findings: [badFinding], suppressed: 0, rationale: '',
    }))
    const reviewer = new CriticalReviewer(llm)
    const result = await reviewer.review([makeWriterOutput()], 2, 'run-001')

    expect(result.findings[0]!.id).toBe('finding-0')
  })
})

// ─── CriticalReviewer — meta fields ──────────────────────────────────────────

describe('CriticalReviewer — meta fields', () => {
  it('returns llm_used from ChatResult.model', async () => {
    const json = makeReviewJson('no_issues', [], 0, 'OK')
    const llm = new MockLLMClient()
    llm.setNextResponse(json)
    const reviewer = new CriticalReviewer(llm)
    const result = await reviewer.review([makeWriterOutput()], 2, 'run-001')

    // MockLLMClient returns options.model; agent passes 'powerful'
    expect(result.meta.llm_used).toBe('powerful')
    expect(result.meta.tokens_input).toBeGreaterThanOrEqual(0)
    expect(result.meta.tokens_output).toBeGreaterThanOrEqual(0)
    expect(result.meta.duration_seconds).toBeGreaterThanOrEqual(0)
  })
})
