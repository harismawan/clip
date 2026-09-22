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
import { db, renders, clips, jobs, videos } from '../db/index.ts'
import { storage } from '../s3.ts'
import { env } from '../env.ts'
import { verifyMedia, type MediaKind } from '../../../shared/mediaToken.ts'
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

const KINDS: MediaKind[] = ['video', 'thumb', 'proxy', 'strip', 'source', 'sourcestrip']

/** Narrow a query string to a known kind, so an unknown one cannot be signed for. */
export function parseKind(raw: string | undefined): MediaKind | null {
  return KINDS.find((k) => k === raw) ?? null
}

/** Where a kind's bytes live: its key, the backend holding it, and its size. */
export interface Located {
  key: string
  backend: string
  /** 0 when unknown, which disables range serving rather than guessing. */
  size: number
}

/**
 * Resolve a claim to an object.
 *
 * `video` and `thumb` hang off the renders row for a ratio; the editor assets
 * hang off the clip itself, because they are ratio-independent -- one proxy of
 * the source window serves every crop.
 */
export async function locate(
  clipId: string,
  ratio: string,
  kind: MediaKind,
): Promise<Located | null> {
  /**
   * The full-length assets, reached clip -> job -> video.
   *
   * One join further than everything else here, and the only place that join
   * matters: ownership is still "do you own this clip", which is what keeps a
   * shared video from needing a rule of its own.
   */
  if (kind === 'source' || kind === 'sourcestrip') {
    const [row] = await db
      .select({ video: videos })
      .from(clips)
      .innerJoin(jobs, eq(clips.jobId, jobs.id))
      .innerJoin(videos, eq(jobs.videoId, videos.id))
      .where(eq(clips.id, clipId))
      .limit(1)

    const video = row?.video
    if (!video) return null
    const key = kind === 'source' ? video.proxyKey : video.stripKey
    if (!key || !video.assetStorage) return null
    return {
      key,
      backend: video.assetStorage,
      // Only the proxy is range-served; the strip is one small image.
      size: kind === 'source' ? (video.proxyBytes ?? 0) : 0,
    }
  }

  if (kind === 'proxy' || kind === 'strip') {
    const [clip] = await db.select().from(clips).where(eq(clips.id, clipId)).limit(1)
    if (!clip) return null
    const key = kind === 'proxy' ? clip.proxyKey : clip.stripKey
    if (!key) return null
    return {
      key,
      backend: clip.assetStorage,
      size: kind === 'proxy' ? (clip.proxyBytes ?? 0) : 0,
    }
  }

  const [render] = await db
    .select()
    .from(renders)
    .where(and(eq(renders.clipId, clipId), eq(renders.ratio, ratio)))
    .limit(1)

  const key = kind === 'video' ? render?.s3Key : render?.thumbKey
  if (!key || render.status !== 'ready') return null
  return { key, backend: render.storage, size: render.sizeBytes ?? 0 }
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
  const isMp4 = ext.toLowerCase() === 'mp4'
  /**
   * `kind` is explicit now that two kinds share the .mp4 extension. Falling back
   * to the extension keeps URLs signed before the editor assets existed valid
   * for the rest of their six-hour life.
   */
  const kind = parseKind(c.req.query('kind')) ?? (isMp4 ? 'video' : 'thumb')
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

  const located = await locate(clipId, ratio, kind)
  if (!located) return c.json({ error: 'Not ready' }, 404)
  const { key, backend, size } = located

  const headers: Record<string, string> = {
    'Content-Type': isMp4 ? 'video/mp4' : 'image/jpeg',
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
  const rangeable = isMp4 && size > 0
  const wanted = rangeable ? parseRange(c.req.header('range'), size) : null

  if (wanted === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' },
    })
  }

  if (rangeable) headers['Accept-Ranges'] = 'bytes'

  if (wanted) {
    const body = await (await storage.get(backend)).getStream(
      key,
      `bytes=${wanted.start}-${wanted.end}`,
    )
    return new Response(Readable.toWeb(Readable.from(body as any)) as ReadableStream, {
      status: 206,
      headers: {
        ...headers,
        'Content-Range': `bytes ${wanted.start}-${wanted.end}/${size}`,
        'Content-Length': String(wanted.end - wanted.start + 1),
      },
    })
  }

  const body = await (await storage.get(backend)).getStream(key)
  if (rangeable) headers['Content-Length'] = String(size)

  return new Response(Readable.toWeb(Readable.from(body as any)) as ReadableStream, { headers })
})
