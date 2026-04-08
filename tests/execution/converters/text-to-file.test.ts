// tests/execution/converters/text-to-file.test.ts
import { convertToFile, stripMarkdownFences, MAX_ARTIFACT_SIZE_BYTES } from '@/lib/execution/converters/text-to-file'

describe('stripMarkdownFences', () => {
  it('strips ```json ... ``` fences', () => {
    expect(stripMarkdownFences('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('strips plain ``` fences', () => {
    expect(stripMarkdownFences('```\nhello\n```')).toBe('hello')
  })

  it('does not strip fences in the middle of content', () => {
    const content = 'line1\n```code\nline2\n```\nline3'
    expect(stripMarkdownFences(content)).toBe(content)
  })

  it('returns unchanged string with no fences', () => {
    expect(stripMarkdownFences('plain content')).toBe('plain content')
  })
})

describe('convertToFile', () => {
  // ─── txt ───────────────────────────────────────────────────────────────────
  it('txt: strips fences and returns text/plain', async () => {
    const { bytes, mimeType, filename } = await convertToFile('```\nhello world\n```', 'txt', 'test-doc')
    expect(bytes.toString('utf-8')).toBe('hello world')
    expect(mimeType).toBe('text/plain')
    expect(filename).toMatch(/\.txt$/)
  })

  // ─── md ────────────────────────────────────────────────────────────────────
  it('md: preserves fences, returns text/markdown', async () => {
    const content = '# Title\n\nParagraph\n\n```code\nlet x = 1\n```'
    const { bytes, mimeType } = await convertToFile(content, 'md', 'doc')
    expect(bytes.toString('utf-8')).toBe(content)
    expect(mimeType).toBe('text/markdown')
  })

  // ─── csv ───────────────────────────────────────────────────────────────────
  it('csv: strips fences, sanitizes formula injection, returns text/csv', async () => {
    const { bytes, mimeType } = await convertToFile('```csv\nhello,=world\nfoo,bar\n```', 'csv', 'test')
    const text = bytes.toString('utf-8')
    expect(mimeType).toBe('text/csv')
    // =world should be prefixed with '
    expect(text).toContain("'=world")
  })

  it('csv: non-formula cell is unchanged', async () => {
    const { bytes } = await convertToFile('name,value\nfoo,bar', 'csv', 'data')
    expect(bytes.toString('utf-8')).toContain('foo,bar')
  })

  // ─── json ──────────────────────────────────────────────────────────────────
  it('json: validates and canonicalises JSON', async () => {
    const { bytes, mimeType } = await convertToFile('```json\n{"b":2,"a":1}\n```', 'json', 'data')
    expect(mimeType).toBe('application/json')
    const parsed = JSON.parse(bytes.toString('utf-8'))
    expect(parsed).toEqual({ b: 2, a: 1 })
  })

  it('json: throws on invalid JSON', async () => {
    await expect(convertToFile('not json', 'json', 'bad')).rejects.toThrow()
  })

  // ─── yaml ──────────────────────────────────────────────────────────────────
  it('yaml: strips fences, returns text/yaml', async () => {
    const { bytes, mimeType } = await convertToFile('```yaml\nkey: value\n```', 'yaml', 'cfg')
    expect(bytes.toString('utf-8')).toBe('key: value')
    expect(mimeType).toBe('text/yaml')
  })

  // ─── html ──────────────────────────────────────────────────────────────────
  it('html: preserves full document without stripping', async () => {
    const html = '<!DOCTYPE html>\n<html><body><p>Hello</p></body></html>'
    const { bytes, mimeType } = await convertToFile(html, 'html', 'page')
    expect(bytes.toString('utf-8')).toBe(html)
    expect(mimeType).toBe('text/html')
  })

  // ─── code formats ──────────────────────────────────────────────────────────
  it('py: strips fences', async () => {
    const { bytes, mimeType } = await convertToFile('```python\nprint("hi")\n```', 'py', 'script')
    expect(bytes.toString('utf-8')).toBe('print("hi")')
    expect(mimeType).toBe('text/plain')
  })

  it('sh: strips fences', async () => {
    const { bytes } = await convertToFile('```bash\necho hello\n```', 'sh', 'run')
    expect(bytes.toString('utf-8')).toBe('echo hello')
  })

  // ─── Phase B stubs ─────────────────────────────────────────────────────────
  it('docx: throws Phase B not implemented error', async () => {
    await expect(convertToFile('content', 'docx', 'doc')).rejects.toThrow(/Phase B/)
  })

  it('pdf: throws Phase B not implemented error', async () => {
    await expect(convertToFile('content', 'pdf', 'doc')).rejects.toThrow(/Phase B/)
  })

  // ─── Size check (validateArtifact enforces this; convertToFile does not) ───
  it('produces buffer for large content up to limit', async () => {
    const big = 'a'.repeat(1024 * 1024) // 1 MB — under 10 MB
    const { bytes } = await convertToFile(big, 'txt', 'large')
    expect(bytes.byteLength).toBe(1024 * 1024)
  })

  it('MAX_ARTIFACT_SIZE_BYTES is 10 MB', () => {
    expect(MAX_ARTIFACT_SIZE_BYTES).toBe(10 * 1024 * 1024)
  })
})
