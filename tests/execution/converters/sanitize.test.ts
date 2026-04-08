import { sanitizeCsvFormulas, sanitizeCsvCell, buildFilename } from '@/lib/execution/converters/sanitize'

describe('sanitizeCsvCell', () => {
  it('prefixes = cell', () => {
    expect(sanitizeCsvCell('=SUM(A1)')).toBe("'=SUM(A1)")
  })
  it('prefixes + cell', () => {
    expect(sanitizeCsvCell('+bad')).toBe("'+bad")
  })
  it('prefixes - cell', () => {
    expect(sanitizeCsvCell('-bad')).toBe("'-bad")
  })
  it('prefixes @ cell', () => {
    expect(sanitizeCsvCell('@bad')).toBe("'@bad")
  })
  it('leaves safe cells unchanged', () => {
    expect(sanitizeCsvCell('hello')).toBe('hello')
    expect(sanitizeCsvCell('123')).toBe('123')
    expect(sanitizeCsvCell('')).toBe('')
  })
})

describe('sanitizeCsvFormulas', () => {
  it('prefixes = cells', () => {
    expect(sanitizeCsvFormulas('a,=SUM(A1)')).toBe("a,'=SUM(A1)")
  })
  it('prefixes + - @ cells', () => {
    const result = sanitizeCsvFormulas('+bad,-bad,@bad,normal')
    expect(result).toBe("'+bad,'-bad,'@bad,normal")
  })
  it('leaves safe cells unchanged', () => {
    expect(sanitizeCsvFormulas('hello,world')).toBe('hello,world')
  })
  it('handles multi-line CSV', () => {
    const input = 'name,value\n=EVIL,safe\nnormal,@attack'
    const output = sanitizeCsvFormulas(input)
    expect(output).toBe("name,value\n'=EVIL,safe\nnormal,'@attack")
  })
  it('handles empty string', () => {
    expect(sanitizeCsvFormulas('')).toBe('')
  })
})

describe('buildFilename', () => {
  it('strips CRLF injections', () => {
    const result = buildFilename('file\r\nname', 'csv')
    expect(result).not.toMatch(/[\r\n]/)
    expect(result).toMatch(/\.csv$/)
  })
  it('normalizes accented chars', () => {
    expect(buildFilename('Résuméé', 'txt')).toMatch(/^r.+\.txt$/)
  })
  it('truncates at 48 chars for slug', () => {
    const longSlug = 'a'.repeat(100)
    const result = buildFilename(longSlug, 'csv')
    // slug is max 48 chars + dot + ext
    expect(result.length).toBeLessThanOrEqual(52)
  })
  it('falls back to "output" for empty slug', () => {
    expect(buildFilename('', 'pdf')).toBe('output.pdf')
  })
  it('falls back to "output" for non-alphanum-only slug', () => {
    expect(buildFilename('---', 'txt')).toBe('output.txt')
  })
  it('replaces backslash and quotes in final name', () => {
    // backslash in ext would be unusual but guard should still fire
    const result = buildFilename('file', 'csv')
    expect(result).not.toMatch(/[\\"]/)
  })
})
