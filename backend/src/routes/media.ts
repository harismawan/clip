/**
 * Media delivery. Mounted OUTSIDE the API-token middleware: these URLs carry
 * their own HMAC signature so that <img> and <a download>, which cannot set an
 * Authorization header, still work.
 */
import { Hono } from 'hono'
import { Readable } from 'node:stream'
import { and, eq } from 'drizzle-orm'
import { db, renders, clips } from '../db/index.ts'
import { s3 } from '../s3.ts'
import { env } from '../env.ts'
import { verifyMedia } from '../../../shared/mediaToken.ts'
import { slugify } from '../../../shared/format.ts'

export const mediaRoutes = new Hono()

mediaRoutes.get('/:file', async (c) => {
  const file = c.req.param('file')
  const m = file.match(/^([0-9a-f-]{36})\.(mp4|jpg)$/i)
  if (!m) return c.json({ error: 'Not found' }, 404)

  const [, clipId, ext] = m
  const kind = ext.toLowerCase() === 'mp4' ? 'video' : 'thumb'
  const ratio = c.req.query('ratio') ?? '9:16'
  const exp = Number(c.req.query('exp'))
  const sig = c.req.query('sig') ?? ''

  if (!verifyMedia(env.API_TOKEN, { clipId, ratio, kind, exp }, sig)) {
    return c.json({ error: 'Link expired or invalid' }, 403)
  }

  const [render] = await db
    .select()
    .from(renders)
    .where(and(eq(renders.clipId, clipId), eq(renders.ratio, ratio)))
    .limit(1)

  const key = kind === 'video' ? render?.s3Key : render?.thumbKey
  if (!key || render.status !== 'ready') return c.json({ error: 'Not ready' }, 404)

  const body = await s3.getStream(key)

  const headers: Record<string, string> = {
    'Content-Type': kind === 'video' ? 'video/mp4' : 'image/jpeg',
    // Signed URLs already expire; caching until then avoids re-streaming a
    // thumbnail on every grid render.
    'Cache-Control': 'private, max-age=3600',
  }
  if (render.sizeBytes && kind === 'video') headers['Content-Length'] = String(render.sizeBytes)

  if (c.req.query('download') === '1') {
    const [clip] = await db.select().from(clips).where(eq(clips.id, clipId)).limit(1)
    const idx = String((clip?.idx ?? 0) + 1).padStart(2, '0')
    const name = `${idx}_${slugify(clip?.title ?? 'clip')}.mp4`
    headers['Content-Disposition'] = `attachment; filename="${name}"`
  }

  return new Response(Readable.toWeb(Readable.from(body as any)) as ReadableStream, { headers })
})
