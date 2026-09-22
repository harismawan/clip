/**
 * Which projects a user can still reach, against a real Postgres.
 *
 * `listProjects` used to return only `status = 'completed'`. A job killed
 * mid-flight after its clips had rendered -- and then marked terminal to free
 * the owner's quota slot -- vanished from the list, taking perfectly good
 * rendered clips with it. The editor could still be opened from a stale tab,
 * which is how the bug was found: it played, it trimmed, and then it refused
 * the save.
 *
 * The rule that replaced it: a project is reachable once it is no longer in
 * flight AND it actually produced a clip. The second half matters -- a job that
 * failed during the download has nothing to show and would just be noise.
 *
 * Opt-in, because it needs the database up:
 *
 *   GOOGLE_CLIENT_ID=x GOOGLE_CLIENT_SECRET=x RUN_DB_TESTS=1 \
 *     bun --env-file=../.env test projects.visibility
 */
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { eq } from 'drizzle-orm'

const ENABLED = process.env.RUN_DB_TESTS === '1'
const maybe = ENABLED ? test : test.skip

// Imported inside beforeAll: db/index.ts pulls in env.ts, which exits the
// process when .env is absent. A skipped test must stay importable.
let db: (typeof import('./db/index.ts'))['db']
let users: (typeof import('./db/index.ts'))['users']
let videos: (typeof import('./db/index.ts'))['videos']
let jobs: (typeof import('./db/index.ts'))['jobs']
let clips: (typeof import('./db/index.ts'))['clips']
let listProjects: (typeof import('./routes/jobs.ts'))['listProjects']

let owner = ''
let videoId = ''
let completedJob = ''
let cancelledJob = ''
let failedWithClips = ''
let failedNoClips = ''
let runningJob = ''

/** A job row for this fixture, in whatever state the case needs. */
function jobValues(status: 'completed' | 'cancelled' | 'failed' | 'rendering') {
  return {
    userId: owner,
    videoId,
    clipCount: 2,
    lengthPreset: 1,
    formats: { '9:16': true },
    burnSubtitles: true,
    status,
    // Every terminal row carries one; the running row must not.
    completedAt: status === 'rendering' ? null : new Date(),
  }
}

async function addClip(jobId: string, idx = 0) {
  await db.insert(clips).values({
    jobId,
    idx,
    title: 'Fixture clip',
    startSeconds: 0,
    endSeconds: 30,
    score: 50,
    snippet: 's',
    caption: 'c',
    subtitleLine: 'l',
    status: 'ready',
  })
}

beforeAll(async () => {
  if (!ENABLED) return

  const dbMod = await import('./db/index.ts')
  ;({ db, users, videos, jobs, clips } = dbMod)
  ;({ listProjects } = await import('./routes/jobs.ts'))

  const stamp = Date.now()
  const [u] = await db
    .insert(users)
    .values({ googleSub: `test-vis-${stamp}`, email: 'vis@test.invalid' })
    .returning()
  owner = u.id

  const [v] = await db
    .insert(videos)
    .values({
      url: `https://test.invalid/visibility-${stamp}`,
      platform: 'test',
      title: 'Visibility fixture',
      durationSeconds: 600,
    })
    .returning()
  videoId = v.id

  const [done] = await db.insert(jobs).values(jobValues('completed')).returning()
  const [cancelled] = await db.insert(jobs).values(jobValues('cancelled')).returning()
  const [failedYes] = await db.insert(jobs).values(jobValues('failed')).returning()
  const [failedNo] = await db.insert(jobs).values(jobValues('failed')).returning()
  const [running] = await db.insert(jobs).values(jobValues('rendering')).returning()

  completedJob = done.id
  cancelledJob = cancelled.id
  failedWithClips = failedYes.id
  failedNoClips = failedNo.id
  runningJob = running.id

  await addClip(completedJob)
  await addClip(cancelledJob)
  await addClip(failedWithClips)
  await addClip(runningJob)
  // failedNoClips deliberately gets none.
})

afterAll(async () => {
  if (!ENABLED) return
  await db.delete(users).where(eq(users.id, owner)).catch(() => {})
  await db.delete(videos).where(eq(videos.id, videoId)).catch(() => {})
})

maybe('a completed project is listed, as it always was', async () => {
  const ids = (await listProjects(owner)).map((p) => p.id)
  expect(ids).toContain(completedJob)
})

maybe('a cancelled project that produced clips stays reachable', async () => {
  // The case from the bug report: its clips rendered, so they are worth keeping
  // and worth editing.
  const ids = (await listProjects(owner)).map((p) => p.id)
  expect(ids).toContain(cancelledJob)
})

maybe('a failed project that produced clips stays reachable', async () => {
  const ids = (await listProjects(owner)).map((p) => p.id)
  expect(ids).toContain(failedWithClips)
})

maybe('a project that produced nothing is not listed', async () => {
  // Nothing to open, nothing to edit -- listing it would only be noise.
  const ids = (await listProjects(owner)).map((p) => p.id)
  expect(ids).not.toContain(failedNoClips)
})

maybe('a job still in flight is not listed', async () => {
  // It is about to rewrite its own clip list; the results screen would be
  // showing rows that are about to be deleted.
  const ids = (await listProjects(owner)).map((p) => p.id)
  expect(ids).not.toContain(runningJob)
})
