/**
 * Media delivery. Mounted OUTSIDE the session middleware, but not public.
 *
 * Two independent checks must both pass: the URL's own HMAC signature, and a
 * session belonging to the clip's owner. The signature alone was enough in Tier
 * A, when one token meant one pool of projects; with accounts, a link that works
 * for anyone who has it is a hole in per-user isolation.
 *
 * It does its own session check rather than sitting behind requireSession
 * because the failure mode differs: a JSON 401 body is invisible to an <img>,
 * which would simply render broken with no clue why. Everything here answers 403
 * for a bad signature and 404 for "not yours", exactly as it would for a clip
 * that does not exist.
 *
 * Same-origin <img>, <video> and <a download> send cookies automatically, so
 * nothing in the app has to know about any of this.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { Readable } from 'node:stream'
import { and, eq } from 'drizzle-orm'
import { getCookie } from 'hono/cookie'
import { db, renders, clips } from '../db/index.ts'
import { s3 } from '../s3.ts'
import { env } from '../env.ts'
import { verifyMedia } from '../../../shared/mediaToken.ts'
import { slugify } from '../../../shared/format.ts'
import { SESSION_COOKIE } from '../auth.ts'
import { hashToken, isExpired } from '../session.ts'
import { lookupSession } from '../sessionStore.ts'
import { ownedClip } from '../ownership.ts'

export const mediaRoutes = new Hono()

/** An inclusive byte range, or null for "send the whole thing". */
export type ByteRange = { start: number; end: number }

/**
 * Parse a Range header against a known object size.
 *
 * Returns null when the whole object should be sent (absent, malformed, or a
 * multi-range request we decline to encode as multipart), and 'unsatisfiable'
 * when the client asked for bytes that do not exist -- which is a 416, not a
 * silent clamp, because quietly returning different bytes than were requested
 * corrupts a seek.
 */
export function parseRange(
  header: string | null | undefined,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (!header) return null

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null

  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null
  if (size <= 0) return 'unsatisfiable'

  let start: number
  let end: number

  if (rawStart === '') {
    // Suffix form: the last N bytes.
    const wanted = Number(rawEnd)
    if (wanted <= 0) return 'unsatisfiable'
    start = Math.max(0, size - wanted)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  }

  if (start >= size || end < start) return 'unsatisfiable'
  return { start, end }
}

/** The signed-in user id, or null. Media answers 404 rather than 401. */
async function viewerId(c: Context): Promise<string | null> {
  const token = getCookie(c, SESSION_COOKIE) ?? ''
  if (!token) return null
  const found = await lookupSession(hashToken(token))
  if (!found || isExpired(found.expiresAt)) return null
  return found.user.id
}

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

  // A valid signature is no longer sufficient. The viewer must be signed in AND
  // own the clip, so a leaked or shared URL is useless to anyone else.
  const viewer = await viewerId(c)
  if (!viewer || !(await ownedClip(viewer, clipId))) {
    return c.json({ error: 'Not found' }, 404)
  }

  const [render] = await db
    .select()
    .from(renders)
    .where(and(eq(renders.clipId, clipId), eq(renders.ratio, ratio)))
    .limit(1)

  const key = kind === 'video' ? render?.s3Key : render?.thumbKey
  if (!key || render.status !== 'ready') return c.json({ error: 'Not ready' }, 404)

  const headers: Record<string, string> = {
    'Content-Type': kind === 'video' ? 'video/mp4' : 'image/jpeg',
    // Signed URLs already expire; caching until then avoids re-streaming a
    // thumbnail on every grid render.
    'Cache-Control': 'private, max-age=3600',
  }

  if (c.req.query('download') === '1') {
    const [clip] = await db.select().from(clips).where(eq(clips.id, clipId)).limit(1)
    const idx = String((clip?.idx ?? 0) + 1).padStart(2, '0')
    const name = `${idx}_${slugify(clip?.title ?? 'clip')}.mp4`
    headers['Content-Disposition'] = `attachment; filename="${name}"`
  }

  /**
   * Range requests, so the player's scrubber works.
   *
   * Only for video, and only when the stored size is known -- a range has to be
   * resolved against a length, and without Accept-Ranges the browser will not
   * ask for one anyway. Thumbnails are small enough that it never matters.
   */
  const size = render.sizeBytes ?? 0
  const rangeable = kind === 'video' && size > 0
  const wanted = rangeable ? parseRange(c.req.header('range'), size) : null

  if (wanted === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' },
    })
  }

  if (rangeable) headers['Accept-Ranges'] = 'bytes'

  if (wanted) {
    const body = await s3.getStream(key, `bytes=${wanted.start}-${wanted.end}`)
    return new Response(Readable.toWeb(Readable.from(body as any)) as ReadableStream, {
      status: 206,
      headers: {
        ...headers,
        'Content-Range': `bytes ${wanted.start}-${wanted.end}/${size}`,
        'Content-Length': String(wanted.end - wanted.start + 1),
      },
    })
  }

  const body = await s3.getStream(key)
  if (rangeable) headers['Content-Length'] = String(size)

  return new Response(Readable.toWeb(Readable.from(body as any)) as ReadableStream, { headers })
})
