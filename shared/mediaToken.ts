/**
 * Short-lived signed media URLs.
 *
 * Presigned S3 URLs cannot be used here: MinIO is bound to localhost, so a
 * presigned URL names a host the browser cannot reach, and the signature is
 * host-bound so it cannot simply be rewritten. Publishing MinIO instead would
 * expose its console and every object alongside it.
 *
 * These URLs are also usable from <img> and <a download>, which cannot send an
 * Authorization header -- and they carry no API token, so a shared or logged
 * URL grants one object for a few hours, not the whole API.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * What a signed URL points at.
 *
 * `video` and `thumb` resolve against the renders row for a given ratio;
 * `proxy` and `strip` are the editor assets and hang off the clip itself, so
 * their ratio is a constant placeholder (see RATIOLESS).
 */
export type MediaKind = 'video' | 'thumb' | 'proxy' | 'strip'

/**
 * The `ratio` used for kinds that have none.
 *
 * It is still signed and still compared, so it cannot be varied to forge a
 * different claim -- it simply carries no meaning for these two kinds.
 */
export const RATIOLESS = 'src'

/** Kinds served as MP4; the rest are JPEG. */
const VIDEO_KINDS = new Set<MediaKind>(['video', 'proxy'])

export function extFor(kind: MediaKind): 'mp4' | 'jpg' {
  return VIDEO_KINDS.has(kind) ? 'mp4' : 'jpg'
}

export interface MediaClaim {
  clipId: string
  ratio: string
  kind: MediaKind
  /** Unix seconds. */
  exp: number
}

function payload(c: MediaClaim): string {
  return `${c.kind}:${c.clipId}:${c.ratio}:${c.exp}`
}

export function signMedia(secret: string, claim: MediaClaim): string {
  return createHmac('sha256', secret).update(payload(claim)).digest('base64url')
}

export function verifyMedia(secret: string, claim: MediaClaim, sig: string): boolean {
  if (!Number.isFinite(claim.exp) || claim.exp * 1000 < Date.now()) return false

  const expected = Buffer.from(signMedia(secret, claim))
  const given = Buffer.from(sig)
  if (expected.length !== given.length) {
    // Constant-time regardless of length mismatch.
    timingSafeEqual(expected, expected)
    return false
  }
  return timingSafeEqual(expected, given)
}

/**
 * Build a signed URL. `base` is the publicly reachable API origin, which is not
 * necessarily where the server is bound (nginx terminates TLS in front).
 */
export function mediaUrl(
  base: string,
  secret: string,
  clipId: string,
  ratio: string,
  kind: MediaKind,
  ttlSeconds = 6 * 3600,
): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds
  const sig = signMedia(secret, { clipId, ratio, kind, exp })
  const q = new URLSearchParams({ ratio, exp: String(exp), sig, kind })
  return `${base.replace(/\/$/, '')}/api/media/${clipId}.${extFor(kind)}?${q}`
}
