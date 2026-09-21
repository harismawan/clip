import { Hono } from 'hono'
import { z } from 'zod'
import { eq, and, inArray } from 'drizzle-orm'
import { Readable } from 'node:stream'
import archiver from 'archiver'
import { db, clips, renders, jobs } from '../db/index.ts'
import { ownedClip, ownedClips } from '../ownership.ts'
import { storage } from '../s3.ts'
import { enqueueRecut } from '../queue.ts'
import { RATIOS } from '../../../shared/types.ts'
import type { Ratio } from '../../../shared/types.ts'
import { slugify } from '../../../shared/format.ts'
import { mediaUrl } from '../../../shared/mediaToken.ts'
import { env } from '../env.ts'

export const clipsRoutes = new Hono()

const ratioQuery = z.enum(RATIOS as unknown as [Ratio, ...Ratio[]]).optional()

/** Redirect to a presigned URL rather than proxying the bytes through the API. */
clipsRoutes.get('/:id/download', async (c) => {
  // 404, not 403: a clip you do not own must be indistinguishable from one that
  // does not exist, or the response confirms somebody else has it.
  if (!(await ownedClip(c.get('user').id, c.req.param('id')))) {
    return c.json({ error: 'That clip is not ready yet.' }, 404)
  }

  const ratio = ratioQuery.safeParse(c.req.query('ratio'))
  const [render] = await db
    .select()
    .from(renders)
    .where(
      ratio.success && ratio.data
        ? and(eq(renders.clipId, c.req.param('id')), eq(renders.ratio, ratio.data))
        : eq(renders.clipId, c.req.param('id')),
    )
    .limit(1)

  if (!render?.s3Key || render.status !== 'ready') {
    return c.json({ error: 'That clip is not ready yet.' }, 404)
  }

  // Hand back a short-lived signed media URL rather than a presigned S3 one:
  // MinIO is localhost-bound, so a presigned URL names a host the browser
  // cannot reach.
  const url = mediaUrl(
    env.PUBLIC_API_URL,
    env.API_TOKEN,
    render.clipId,
    render.ratio,
    'video',
    300,
  )
  return c.redirect(`${url}&download=1`)
})

/**
 * Re-cut one clip. Reuses the existing transcript and asks the model for an
 * alternative range near the original, which is far cheaper than re-analysing
 * the whole video.
 */
clipsRoutes.post('/:id/redo', async (c) => {
  const id = c.req.param('id')
  const clip = await ownedClip(c.get('user').id, id)
  if (!clip) return c.json({ error: 'Clip not found' }, 404)

  const [job] = await db.select().from(jobs).where(eq(jobs.id, clip.jobId)).limit(1)
  if (!job) return c.json({ error: 'Job not found' }, 404)
  if (job.status !== 'completed') {
    return c.json({ error: 'Wait for the job to finish before re-cutting.' }, 409)
  }

  await db.update(clips).set({ status: 'pending', error: null }).where(eq(clips.id, id))
  await enqueueRecut({ jobId: clip.jobId, clipId: id })

  return c.json({ ok: true })
})

const zipBody = z.object({
  clipIds: z.array(z.string().uuid()).min(1).max(100),
  ratio: z.enum(RATIOS as unknown as [Ratio, ...Ratio[]]).default('9:16'),
})

export const downloadsRoutes = new Hono()

/** Stream a zip of the selected clips. */
downloadsRoutes.post('/', async (c) => {
  const parsed = zipBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400)
  }
  const { clipIds, ratio } = parsed.data

  // The ids arrive in a request body, so this is the easiest endpoint in the API
  // to leak somebody else's render from. Everything downstream uses `ownedIds`,
  // never the caller's list.
  const clipRows = await ownedClips(c.get('user').id, clipIds)
  if (clipRows.length === 0) return c.json({ error: 'No clips found.' }, 404)
  const ownedIds = clipRows.map((x) => x.id)

  const renderRows = await db
    .select()
    .from(renders)
    .where(and(inArray(renders.clipId, ownedIds), eq(renders.ratio, ratio)))

  const ready = renderRows.filter((r) => r.status === 'ready' && r.s3Key)
  if (ready.length === 0) {
    return c.json({ error: `No ${ratio} renders are ready yet.` }, 404)
  }

  const titleById = new Map(clipRows.map((x) => [x.id, x]))

  // Level 0: MP4 is already compressed, so deflate burns CPU we do not have
  // for roughly zero size reduction.
  const archive = archiver('zip', { zlib: { level: 0 } })
  archive.on('error', (err) => console.error('[zip] archive error:', err.message))

  // Append lazily as the archive drains, rather than buffering every clip in
  // memory first -- 24 clips at 20MB would be 480MB of heap on a 4GB box.
  void (async () => {
    try {
      for (const r of ready) {
        const clip = titleById.get(r.clipId)
        const idx = String((clip?.idx ?? 0) + 1).padStart(2, '0')
        const name = `${idx}_${slugify(clip?.title ?? 'clip')}.mp4`
        // Per row: a zip can legitimately span backends when a project was
        // re-cut after the write target moved. Clients are memoised, so this is
        // a map lookup rather than a new connection per clip.
        const stream = await (await storage.get(r.storage)).getStream(r.s3Key!)
        archive.append(Readable.from(stream as any), { name })
      }
      await archive.finalize()
    } catch (e) {
      console.error('[zip] failed while streaming:', (e as Error).message)
      archive.abort()
    }
  })()

  return new Response(Readable.toWeb(archive) as ReadableStream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="clips-${ratio.replace(':', 'x')}.zip"`,
    },
  })
})
