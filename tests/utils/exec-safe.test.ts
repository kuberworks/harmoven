// tests/utils/exec-safe.test.ts
// Unit tests for exec-safe utility — assertSafePath validation.
// execFileAsync calls are tested indirectly via config-store tests.

import { assertSafePath } from '@/lib/utils/exec-safe'

describe('assertSafePath', () => {
  it('allows a normal absolute path', () => {
    expect(assertSafePath('/data/config.git')).toBe('/data/config.git')
  })

  it('allows a relative path without traversal', () => {
    expect(assertSafePath('projects/abc/project.json')).toBe('projects/abc/project.json')
  })

  it('throws on empty string', () => {
    expect(() => assertSafePath('')).toThrow(/non-empty/)
  })

  it('throws on null byte in path', () => {
    expect(() => assertSafePath('/data/config\0evil')).toThrow(/null byte/)
  })

  it('throws on path traversal with ..', () => {
    expect(() => assertSafePath('../etc/passwd')).toThrow(/traversal/)
  })

  it('throws on embedded .. traversal', () => {
    expect(() => assertSafePath('/data/config.git/../../../etc/passwd')).toThrow(/traversal/)
  })

  it('throws on non-string input', () => {
    // @ts-expect-error — testing runtime guard
    expect(() => assertSafePath(null)).toThrow()
    // @ts-expect-error
    expect(() => assertSafePath(42)).toThrow()
  })
})
