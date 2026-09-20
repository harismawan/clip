import { Hono } from 'hono'
import { z } from 'zod'
import { eq, desc } from 'drizzle-orm'
import { db, videos } from '../db/index.ts'
import { probe, assertYtdlpFresh } from '../../../shared/ytdlp.ts'
import { toSourceDTO } from '../mappers.ts'
import { env } from '../env.ts'

const body = z.object({ url: z.string().url('That does not look like a URL.') })

export const sources = new Hono()

/**
 * Resolve a URL to source metadata. Synchronous by design: `yt-dlp --dump-json`
 * returns in a second or two without downloading, so a queued job would add
 * latency and a progress UI for nothing.
 */
sources.post('/analyze', async (c) => {
  const parsed = body.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400)
  }
  const { url } = parsed.data

  await assertYtdlpFresh(env.YTDLP_MAX_AGE_DAYS)

  // Reuse a previously resolved video so a re-analyse does not create a
  // duplicate row (and so its transcript stays reachable).
  const [existing] = await db
    .select()
    .from(videos)
    .where(eq(videos.url, url))
    .orderBy(desc(videos.createdAt))
    .limit(1)

  if (existing) return c.json(toSourceDTO(existing))

  const info = await probe(url)

  const [row] = await db
    .insert(videos)
    .values({
      url,
      platform: info.platform,
      title: info.title,
      durationSeconds: info.durationSeconds,
      thumbnailUrl: info.thumbnail,
      uploader: info.uploader,
      publishedAt: info.uploadDate,
      maxHeight: info.maxHeight,
    })
    .returning()

  return c.json(toSourceDTO(row))
})
