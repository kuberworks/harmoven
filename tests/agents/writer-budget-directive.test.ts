import { buildBudgetDirective } from '@/lib/agents/writer'

describe('buildBudgetDirective', () => {
  // ── Tier boundaries ────────────────────────────────────────────────────────

  describe('tier: tight (≤ 16 384)', () => {
    it('includes TOKEN BUDGET label', () => {
      expect(buildBudgetDirective(8192)).toMatch(/TOKEN BUDGET/)
    })

    it('shows the exact maxOutputTokens number', () => {
      expect(buildBudgetDirective(8192)).toMatch(/8192/)
    })

    it('shows the content budget number', () => {
      // contentBudget = Math.min(8192 - 400, Math.floor(8192 * 0.9)) = Math.min(7792, 7372) = 7372
      expect(buildBudgetDirective(8192)).toMatch(/7372/)
    })

    it('at ceiling (16 384) is still tight', () => {
      expect(buildBudgetDirective(16_384)).toMatch(/TOKEN BUDGET/)
      expect(buildBudgetDirective(16_384)).toMatch(/16384/)
    })

    it('prose node — contains bullet-point guidance', () => {
      expect(buildBudgetDirective(8192, false)).toMatch(/bullet points/)
    })

    it('code node — does NOT contain bullet-point guidance', () => {
      expect(buildBudgetDirective(8192, true)).not.toMatch(/bullet points/)
      expect(buildBudgetDirective(8192, true)).toMatch(/minimal, correct code/)
    })
  })

  describe('tier: normal (> 16 384, ≤ 40 000)', () => {
    it('first above tight ceiling (16 385) enters normal tier', () => {
      expect(buildBudgetDirective(16_385)).toMatch(/TOKEN BUDGET/)
      // normal tier shows the count but NOT the content-budget breakdown
      expect(buildBudgetDirective(16_385)).not.toMatch(/Content budget/)
    })

    it('shows the exact maxOutputTokens number', () => {
      expect(buildBudgetDirective(32_768)).toMatch(/32768/)
    })

    it('at ceiling (40 000) is still normal', () => {
      expect(buildBudgetDirective(40_000)).toMatch(/TOKEN BUDGET/)
    })

    it('prose node — contains verbosity avoidance guidance', () => {
      expect(buildBudgetDirective(32_768, false)).toMatch(/elaboration/)
    })

    it('code node — contains code-specific guidance', () => {
      expect(buildBudgetDirective(32_768, true)).toMatch(/minimal code/)
      expect(buildBudgetDirective(32_768, true)).not.toMatch(/elaboration/)
    })
  })

  describe('tier: large (> 40 000)', () => {
    it('first above normal ceiling (40 001) enters large tier', () => {
      expect(buildBudgetDirective(40_001)).toMatch(/OUTPUT DISCIPLINE/)
    })

    it('shows the token count even in the light reminder', () => {
      expect(buildBudgetDirective(64_000)).toMatch(/64000/)
    })

    it('haiku cap (64 000) is in large tier', () => {
      const d = buildBudgetDirective(64_000)
      expect(d).toMatch(/OUTPUT DISCIPLINE/)
      expect(d).toMatch(/64000/)
    })

    it('does not contain TOKEN BUDGET label', () => {
      expect(buildBudgetDirective(65_536)).not.toMatch(/TOKEN BUDGET/)
    })
  })

  // ── contentBudget correctness (P1 regression guard) ───────────────────────

  describe('contentBudget Math.min correctness', () => {
    it.each([
      [1000,   Math.min(1000 - 400, Math.floor(1000 * 0.9))],  // 540
      [5000,   Math.min(5000 - 400, Math.floor(5000 * 0.9))],  // 4500
      [16384,  Math.min(16384 - 400, Math.floor(16384 * 0.9))], // 14745
    ])('maxTokens=%i → contentBudget=%i shown in tight tier', (n, expected) => {
      expect(buildBudgetDirective(n)).toMatch(String(expected))
    })

    it('content budget is always ≤ (maxTokens - envelope)', () => {
      // Previously Math.max would violate this — guard against regression
      const envelope = 400
      for (const n of [500, 2048, 8192, 16000, 16384]) {
        const d = buildBudgetDirective(n)
        const match = d.match(/Content budget ≈ (\d+)/)
        if (match) {
          expect(Number(match[1])).toBeLessThanOrEqual(n - envelope)
        }
      }
    })
  })

  // ── Boundary values ────────────────────────────────────────────────────────

  it.each([0, 1, 16384, 16385, 40000, 40001, 65536, 131072])(
    'does not throw for boundary value %i',
    (n) => {
      expect(() => buildBudgetDirective(n)).not.toThrow()
      expect(() => buildBudgetDirective(n, true)).not.toThrow()
    },
  )
})
