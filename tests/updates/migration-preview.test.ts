// tests/updates/migration-preview.test.ts
// Unit tests for lib/updates/migration-preview.ts
// DB calls mocked via jest.mock — no real Prisma connection required.

import fs   from 'node:fs'
import path from 'node:path'
import os   from 'node:os'
import { generateMigrationPreview } from '@/lib/updates/migration-preview'

// Mock the DB client — we test the SQL risk classifier without a DB
jest.mock('@/lib/db/client', () => ({
  db: {
    $queryRaw: jest.fn().mockResolvedValue([]),
  },
}))

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a temporary migrations directory with the given SQL files. */
function createTmpMigrationsDir(migrations: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harmoven-mig-test-'))
  for (const [name, sql] of Object.entries(migrations)) {
    const migDir = path.join(dir, name)
    fs.mkdirSync(migDir)
    fs.writeFileSync(path.join(migDir, 'migration.sql'), sql, 'utf8')
  }
  return dir
}

// ─── Risk classifier ──────────────────────────────────────────────────────────

// We test the classifier indirectly via generateMigrationPreview by pointing
// the module at a temp directory.

// Override MIGRATIONS_DIR via jest module mocking
jest.mock('@/lib/updates/migration-preview', () => {
  // Re-import the real module but allow path override in tests
  const original = jest.requireActual('@/lib/updates/migration-preview') as {
    generateMigrationPreview: (migrationsDir?: string) => Promise<unknown>
  }
  return original
})

// Since we can't easily inject migrationsDir without refactoring, we test the
// risk logic by testing the public output with synthetic SQL content.
// For a clean unit test, we expose classifyMigrationRisk via a barrel export
// or test the integration through generateMigrationPreview.
//
// Here we directly test the output risk levels by intercepting fs.readdirSync.

describe('migration risk classification', () => {
  let originalCwd: () => string

  beforeAll(() => {
    originalCwd = process.cwd.bind(process)
  })

  afterAll(() => {
    // Restore — nothing to restore since we used jest.spyOn
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  async function runPreviewWithSql(name: string, sql: string) {
    const tmpDir = createTmpMigrationsDir({ [name]: sql })
    jest.spyOn(process, 'cwd').mockReturnValue(path.dirname(path.dirname(tmpDir)))

    // Point module to tmpDir by mocking path.resolve used inside the module
    // Alternative: we'll spy on fs directly
    const fsSpyReaddir = jest.spyOn(fs, 'readdirSync').mockReturnValue(
      [name] as unknown as ReturnType<typeof fs.readdirSync>
    )
    const fsSpyStat = jest.spyOn(fs, 'statSync').mockReturnValue({
      isDirectory: () => true,
    } as fs.Stats)
    const fsSpyRead = jest.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      if (String(p).endsWith('migration.sql')) return sql
      // For package.json reads (CURRENT_VERSION)
      return JSON.stringify({ version: '1.0.0' })
    })

    const preview = await generateMigrationPreview()

    fsSpyReaddir.mockRestore()
    fsSpyStat.mockRestore()
    fsSpyRead.mockRestore()

    return preview
  }

  it('classifies DROP TABLE as danger', async () => {
    const preview = await runPreviewWithSql(
      '20260101000000_drop_table',
      'DROP TABLE "User";'
    )
    expect(preview.pending[0]?.risk).toBe('danger')
    expect(preview.hasDataLoss).toBe(true)
  })

  it('classifies DROP COLUMN as danger', async () => {
    const preview = await runPreviewWithSql(
      '20260101000000_drop_col',
      'ALTER TABLE "User" DROP COLUMN "email";'
    )
    expect(preview.pending[0]?.risk).toBe('danger')
    expect(preview.hasDataLoss).toBe(true)
  })

  it('classifies CREATE TABLE as safe', async () => {
    const preview = await runPreviewWithSql(
      '20260101000000_create_table',
      'CREATE TABLE "NewModel" ("id" TEXT NOT NULL, CONSTRAINT "NewModel_pkey" PRIMARY KEY ("id"));'
    )
    expect(preview.pending[0]?.risk).toBe('safe')
    expect(preview.hasDataLoss).toBe(false)
  })

  it('classifies ALTER COLUMN as warning', async () => {
    const preview = await runPreviewWithSql(
      '20260101000000_alter_col',
      'ALTER TABLE "User" ALTER COLUMN "name" TYPE VARCHAR(100);'
    )
    expect(preview.pending[0]?.risk).toBe('warning')
  })

  it('classifies TRUNCATE as danger', async () => {
    const preview = await runPreviewWithSql(
      '20260101000000_truncate',
      'TRUNCATE TABLE "Session";'
    )
    expect(preview.pending[0]?.risk).toBe('danger')
    expect(preview.hasDataLoss).toBe(true)
  })

  it('returns empty pending list when no migration dirs exist', async () => {
    jest.spyOn(fs, 'readdirSync').mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>)
    jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => true } as fs.Stats)

    const preview = await generateMigrationPreview()
    expect(preview.pending).toHaveLength(0)
    expect(preview.hasDataLoss).toBe(false)
  })
})
