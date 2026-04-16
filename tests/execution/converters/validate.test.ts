// tests/execution/converters/validate.test.ts
import { validateArtifact } from '@/lib/execution/converters/validate'
import { MAX_ARTIFACT_SIZE_BYTES } from '@/lib/execution/converters/text-to-file'

describe('validateArtifact', () => {
  // ─── Size ──────────────────────────────────────────────────────────────────
  it('passes for content within the 10 MB limit', () => {
    const bytes = Buffer.from('hello', 'utf-8')
    expect(() => validateArtifact(bytes, 'txt')).not.toThrow()
  })

  it('throws when bytes exceed 10 MB', () => {
    const bytes = Buffer.alloc(MAX_ARTIFACT_SIZE_BYTES + 1)
    expect(() => validateArtifact(bytes, 'txt')).toThrow(/10 MB/)
  })

  // ─── JSON ─────────────────────────────────────────────────────────────────
  it('passes for valid JSON bytes', () => {
    const bytes = Buffer.from('{"a":1}', 'utf-8')
    expect(() => validateArtifact(bytes, 'json')).not.toThrow()
  })

  it('throws for invalid JSON bytes', () => {
    const bytes = Buffer.from('{not json}', 'utf-8')
    expect(() => validateArtifact(bytes, 'json')).toThrow()
  })

  it('does not JSON-validate non-json formats', () => {
    // "{not json}" as csv should not throw
    const bytes = Buffer.from('{not json}', 'utf-8')
    expect(() => validateArtifact(bytes, 'csv')).not.toThrow()
  })

  // ─── CSV ──────────────────────────────────────────────────────────────────
  it('passes for CSV with consistent column counts', () => {
    const csv = 'a,b,c\n1,2,3\n4,5,6'
    expect(() => validateArtifact(Buffer.from(csv, 'utf-8'), 'csv')).not.toThrow()
  })

  it('throws for CSV with inconsistent column counts', () => {
    const csv = 'a,b,c\n1,2,3\n4,5'  // last row only 2 cols
    expect(() => validateArtifact(Buffer.from(csv, 'utf-8'), 'csv')).toThrow(/CSV.*column/)
  })

  it('passes for single-row CSV', () => {
    const csv = 'a,b,c'
    expect(() => validateArtifact(Buffer.from(csv, 'utf-8'), 'csv')).not.toThrow()
  })

  it('does not CSV-validate non-csv formats', () => {
    const badCsv = 'a,b\n1,2,3'  // inconsistent but not csv format
    expect(() => validateArtifact(Buffer.from(badCsv, 'utf-8'), 'txt')).not.toThrow()
  })
})
