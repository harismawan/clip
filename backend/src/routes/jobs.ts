import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { eq, and, desc, inArray } from 'drizzle-orm'
import { db, jobs, videos, clips, renders } from '../db/index.ts'
import { ownedJob, countActiveJobs, countJobsSince } from '../ownership.ts'
import { quotaVerdict } from '../quota.ts'
import { env } from '../env.ts'
import { toJobDTO, toSourceDTO } from '../mappers.ts'
import { enqueueProcess, boss, PROCESS_QUEUE } from '../queue.ts'
import { subscribe, ensureListening } from '../events.ts'
import { isTerminal, RATIOS } from '../../../shared/types.ts'
import type { ProjectDTO, Ratio } from '../../../shared/types.ts'
import { s3 } from '../s3.ts'

const createBody = z.object({
  videoId: z.string().uuid(),
  count: z.number().int().min(1).max(24),
  lengthIdx: z.number().int().min(0).max(2),
  formats: z.record(z.boolean()),
  subs: z.boolean(),
})

export const jobsRoutes = new Hono()

/** Create and enqueue a job. */
jobsRoutes.post('/', async (c) => {
  const parsed = createBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400)
  }
  const b = parsed.data

  const enabled = RATIOS.filter((r) => b.formats[r])
  if (enabled.length === 0) {
    return c.json({ error: 'Pick at least one output format.' }, 400)
  }

  // Signup is open to any Google account and the worker runs one job at a time,
  // so this is what stops one person queueing the box out from under everyone.
  const user = c.get('user')
  const refusal = quotaVerdict({
    activeCount: await countActiveJobs(user.id),
    dailyCount: await countJobsSince(user.id, new Date(Date.now() - 86_400_000)),
    dailyLimit: env.QUOTA_JOBS_PER_DAY,
  })
  if (refusal) return c.json({ error: refusal.message }, refusal.status)

  const [video] = await db.select().from(videos).where(eq(videos.id, b.videoId)).limit(1)
  if (!video) return c.json({ error: 'Unknown video. Analyse the URL again.' }, 404)

  const [job] = await db
    .insert(jobs)
    .values({
      userId: user.id,
      videoId: video.id,
      clipCount: b.count,
      lengthPreset: b.lengthIdx,
      formats: Object.fromEntries(enabled.map((r) => [r, true])),
      burnSubtitles: b.subs,
      status: 'pending',
      stage: 'Queued',
    })
    .returning()

  await enqueueProcess({ jobId: job.id })

  return c.json({ jobId: job.id }, 201)
})

/** Full job state: options, source, clips, presigned render URLs. */
jobsRoutes.get('/:id', async (c) => {
  const found = await loadJob(c.get('user').id, c.req.param('id'))
  if (!found) return c.json({ error: 'Job not found' }, 404)
  return c.json(await toJobDTO(found.job, found.video, found.clipRows, found.renderRows))
})

/**
 * Progress stream. Emits the current state immediately so a page refresh does
 * not wait for the next worker tick, then closes once the job is terminal.
 */
jobsRoutes.get('/:id/events', async (c) => {
  const jobId = c.req.param('id')
  const job = await ownedJob(c.get('user').id, jobId)
  if (!job) return c.json({ error: 'Job not found' }, 404)

  await ensureListening()

  return streamSSE(c, async (stream) => {
    let unsubscribe = () => {}
    const done = new Promise<void>((resolve) => {
      unsubscribe = subscribe(jobId, (event) => {
        void stream.writeSSE({ data: JSON.stringify(event) })
        if (isTerminal(event.status)) resolve()
      })
    })

    await stream.writeSSE({
      data: JSON.stringify({
        jobId,
        status: job.status,
        stage: job.stage,
        progress: job.progress,
        error: job.error,
      }),
    })

    // Already finished before the browser connected: nothing more will arrive.
    if (isTerminal(job.status)) {
      unsubscribe()
      return
    }

    // A proxy that sees no bytes for 60s will drop the connection; nginx's
    // default proxy_read_timeout is exactly that. Comment frames keep it warm
    // during a 40-minute transcription that reports rarely.
    const keepAlive = setInterval(() => void stream.writeSSE({ data: '', event: 'ping' }), 20_000)

    stream.onAbort(() => {
      unsubscribe()
      clearInterval(keepAlive)
    })

    await done
    unsubscribe()
    clearInterval(keepAlive)
  })
})

jobsRoutes.post('/:id/cancel', async (c) => {
  const id = c.req.param('id')
  const job = await ownedJob(c.get('user').id, id)
  if (!job) return c.json({ error: 'Job not found' }, 404)
  if (isTerminal(job.status)) return c.json({ ok: true, status: job.status })

  // Mark cancelled first: the worker checks this between stages, so a job that
  // is mid-ffmpeg stops at the next boundary even if the queue cancel misses.
  await db
    .update(jobs)
    .set({ status: 'cancelled', stage: 'Cancelled', completedAt: new Date() })
    .where(eq(jobs.id, id))

  await boss.deleteJob(PROCESS_QUEUE, id).catch(() => {
    // Already claimed by the worker; the status check above handles it.
  })

  return c.json({ ok: true, status: 'cancelled' })
})

/** Re-run a job from scratch, reusing the source and its transcript. */
jobsRoutes.post('/:id/regenerate', async (c) => {
  const id = c.req.param('id')
  const job = await ownedJob(c.get('user').id, id)
  if (!job) return c.json({ error: 'Job not found' }, 404)

  await deleteJobArtifacts(id)

  await db
    .update(jobs)
    .set({
      status: 'pending',
      stage: 'Queued',
      progress: 0,
      error: null,
      startedAt: null,
      completedAt: null,
    })
    .where(eq(jobs.id, id))

  await enqueueProcess({ jobId: id })
  return c.json({ jobId: id })
})

/** Completed jobs, newest first. */
jobsRoutes.get('/', async (c) => {
  const rows = await db
    .select()
    .from(jobs)
    .innerJoin(videos, eq(jobs.videoId, videos.id))
    .where(and(eq(jobs.status, 'completed'), eq(jobs.userId, c.get('user').id)))
    .orderBy(desc(jobs.completedAt))
    .limit(100)

  const out: ProjectDTO[] = rows.map((r) => ({
    id: r.jobs.id,
    title: r.videos.title,
    source: toSourceDTO(r.videos, r.jobs.clipCount),
    clipCount: r.jobs.clipCount,
    createdAt: (r.jobs.completedAt ?? r.jobs.createdAt).getTime(),
  }))

  return c.json(out)
})

async function loadJob(userId: string, id: string) {
  const job = await ownedJob(userId, id)
  if (!job) return null

  const [video] = await db.select().from(videos).where(eq(videos.id, job.videoId)).limit(1)
  if (!video) return null

  const clipRows = await db.select().from(clips).where(eq(clips.jobId, id))
  const renderRows = clipRows.length
    ? await db
        .select()
        .from(renders)
        .where(
          inArray(
            renders.clipId,
            clipRows.map((x) => x.id),
          ),
        )
    : []

  return { job, video, clipRows, renderRows }
}

/**
 * Remove a job's clips and their S3 objects. Called before a regenerate so the
 * old renders do not leak -- the rows cascade, but object storage does not.
 */
export async function deleteJobArtifacts(jobId: string) {
  const clipRows = await db.select().from(clips).where(eq(clips.jobId, jobId))
  if (clipRows.length === 0) return

  const renderRows = await db
    .select()
    .from(renders)
    .where(
      inArray(
        renders.clipId,
        clipRows.map((x) => x.id),
      ),
    )

  const objects = renderRows.flatMap((r) => [r.s3Key, r.thumbKey].filter(Boolean) as string[])
  if (objects.length) {
    await s3.deleteMany(objects).catch((e) => {
      // A storage hiccup must not block the regenerate; worst case is orphans.
      console.error('[jobs] failed to delete old renders:', e.message)
    })
  }

  await db.delete(clips).where(eq(clips.jobId, jobId))
}
