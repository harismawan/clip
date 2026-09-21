/**
 * The storage registry, against a real Postgres.
 *
 * Three of the guarantees in this design live in the SQL rather than in
 * TypeScript, so they can only be tested by running the SQL:
 *
 *   - existing rows were backfilled to 'minio', which is what makes the rollout
 *     non-breaking rather than a mass 404
 *   - a backend that still owns objects cannot be deleted
 *   - two active backends are unrepresentable
 *
 * Opt-in, because it needs the database up:
 *
 *   GOOGLE_CLIENT_ID=x GOOGLE_CLIENT_SECRET=x RUN_DB_TESTS=1 \
 *     bun --env-file=../.env test storage.integration
 */
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { eq } from 'drizzle-orm'

const ENABLED = process.env.RUN_DB_TESTS === '1'
const maybe = ENABLED ? test : test.skip

// Imported inside beforeAll: db/index.ts pulls in env.ts, which exits the
// process when .env is absent. A skipped test must stay importable.
let db: (typeof import('./db/index.ts'))['db']
let storageBackends: (typeof import('./db/index.ts'))['storageBackends']
let renders: (typeof import('./db/index.ts'))['renders']
let pool: (typeof import('./db/index.ts'))['pool']

const TEST_ID = 'zz-test-backend'

beforeAll(async () => {
  if (!ENABLED) return
  const mod = await import('./db/index.ts')
  db = mod.db
  storageBackends = mod.storageBackends
  renders = mod.renders
  pool = mod.pool
})

afterAll(async () => {
  if (!ENABLED) return
  await db.delete(storageBackends).where(eq(storageBackends.id, TEST_ID)).catch(() => {})
  await pool.end().catch(() => {})
})

maybe('the migration seeded minio as the active backend', async () => {
  const [row] = await db.select().from(storageBackends).where(eq(storageBackends.id, 'minio'))
  expect(row).toBeDefined()
  expect(row.bucket).toBe('clips')
  expect(row.pathStyle).toBe(true)
})

maybe('every pre-existing render was backfilled to minio', async () => {
  // Not a guess: rows written before the registry existed came from MinIO.
  // If this backfill were wrong, every old clip would 404 on the first read.
  const rows = await db.select({ storage: renders.storage }).from(renders)
  for (const row of rows) expect(row.storage).toBe('minio')
})

maybe('a second active backend is rejected by the database', async () => {
  await db.insert(storageBackends).values({
    id: TEST_ID,
    label: 'test',
    endpoint: null,
    region: 'us-east-1',
    bucket: 'test',
    pathStyle: false,
    isActive: false,
  })

  // minio is already active; the partial unique index must refuse this even
  // though it is a perfectly ordinary UPDATE. Wrapped in an async call because
  // drizzle's builder is a thenable, which .rejects will not drive on its own.
  await expect(
    (async () =>
      db.update(storageBackends).set({ isActive: true }).where(eq(storageBackends.id, TEST_ID)))(),
  ).rejects.toThrow(/storage_one_active|unique/i)
})

maybe('a backend that owns objects cannot be deleted', async () => {
  const [count] = await db.select({ storage: renders.storage }).from(renders).limit(1)
  if (!count) return // nothing stored yet; the constraint has nothing to bite on

  // The script guards this with a counted message, but the foreign key is the
  // thing that makes it impossible rather than merely discouraged.
  await expect(
    (async () => db.delete(storageBackends).where(eq(storageBackends.id, 'minio')))(),
  ).rejects.toThrow(/foreign key|violates/i)
})
