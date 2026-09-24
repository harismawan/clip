/**
 * The database keeps a cancelled job cancelled -- migration 0011.
 *
 * Opt-in, because it needs the database:
 *
 *   RUN_DB_TESTS=1 bun --env-file=../.env test keepCancelled.integration
 *
 * NEVER point this at production. It creates and deletes a user.
 *
 * The writes here are raw UPDATEs on purpose. They stand in for a worker with
 * no guard of its own -- the dev worker that undid a production cancel and
 * delete twice -- so what is under test is the trigger alone.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { eq } from 'drizzle-orm'

const ENABLED = process.env.RUN_DB_TESTS === '1'
const maybe = ENABLED ? test : test.skip

let db: typeof import('./db/index.ts')['db']
let schema: typeof import('./db/index.ts')

let userId = ''
let videoId = ''
let jobId = ''

beforeAll(async () => {
  if (!ENABLED) return
  schema = await import('./db/index.ts')
  db = schema.db

  const [user] = await db
    .insert(schema.users)
    .values({ email: `keep-${Date.now()}@test.invalid`, googleSub: `keep-${Date.now()}` })
    .returning()
  userId = user!.id
  const [video] = await db
    .insert(schema.videos)
    .values({ url: `test://keep-${Date.now()}`, platform: 'Test', title: 't', durationSeconds: 10 })
    .returning()
  videoId = video!.id
  const [job] = await db
    .insert(schema.jobs)
    .values({ userId, videoId, clipCount: 1, lengthPreset: 0, formats: { '9:16': true } })
    .returning()
  jobId = job!.id
})

afterAll(async () => {
  if (!ENABLED) return
  await db.delete(schema.users).where(eq(schema.users.id, userId)).catch(() => {})
  await db.delete(schema.videos).where(eq(schema.videos.id, videoId)).catch(() => {})
})

const set = (patch: Partial<typeof schema.jobs.$inferInsert>) =>
  db.update(schema.jobs).set(patch).where(eq(schema.jobs.id, jobId)).returning()

const read = async () =>
  (await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)))[0]!

maybe('an unguarded progress write cannot un-cancel a job', async () => {
  await set({ status: 'downloading', stage: 'Starting' })
  await set({ status: 'cancelled', stage: 'Cancelled', completedAt: new Date() })

  const written = await set({ status: 'downloading', stage: 'Downloading source', progress: 3 })
  // Skipped, not errored: an old worker's setStatus sees no row and moves on.
  expect(written).toHaveLength(0)

  const row = await read()
  expect(row.status).toBe('cancelled')
  expect(row.stage).toBe('Cancelled')
})

maybe('nor can it be failed or completed out from under the cancel', async () => {
  await set({ status: 'failed', error: 'yt-dlp exited 1' })
  await set({ status: 'completed' })
  expect((await read()).status).toBe('cancelled')
})

maybe('a cancelled job can still be deleted', async () => {
  // softDeleteJob touches deleted_at only, which the trigger does not watch.
  await db.update(schema.jobs).set({ deletedAt: new Date() }).where(eq(schema.jobs.id, jobId))
  const row = await read()
  expect(row.deletedAt).not.toBeNull()
  expect(row.status).toBe('cancelled')
})

maybe('regenerate still brings a cancelled job back, and it runs normally', async () => {
  await set({ status: 'pending', stage: 'Queued', progress: 0, completedAt: null, deletedAt: null })
  expect((await read()).status).toBe('pending')

  await set({ status: 'downloading', stage: 'Starting' })
  await set({ status: 'rendering', stage: 'Rendering 1 of 1', progress: 72 })
  expect((await read()).status).toBe('rendering')
})
