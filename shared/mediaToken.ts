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

export interface MediaClaim {
  clipId: string
  ratio: string
  kind: 'video' | 'thumb'
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
  kind: 'video' | 'thumb',
  ttlSeconds = 6 * 3600,
): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds
  const sig = signMedia(secret, { clipId, ratio, kind, exp })
  const ext = kind === 'video' ? 'mp4' : 'jpg'
  const q = new URLSearchParams({ ratio, exp: String(exp), sig })
  return `${base.replace(/\/$/, '')}/api/media/${clipId}.${ext}?${q}`
}
