/**
 * Session primitives. Pure and dependency-free on purpose: the cookie, hashing
 * and PKCE rules are the parts that must be right, and keeping them out of the
 * middleware means they can be tested without a database or a live Google.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** 32 random bytes, base64url, unpadded -- 43 chars, cookie-safe. */
function randomToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * The token goes to the browser; only its hash is stored. A database dump
 * therefore cannot be replayed as a live login.
 */
export function newSessionToken(): { token: string; id: string } {
  const token = randomToken()
  return { token, id: hashToken(token) }
}

/**
 * Expiry is inclusive: a session at exactly its expiry instant is dead. The
 * alternative leaves a one-tick window where a revoked-by-time session works.
 */
export function isExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime()
}

export function expiryFrom(ttlDays: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + ttlDays * 86_400_000)
}

/** Opaque anti-CSRF value for the OAuth round trip. */
export function randomState(): string {
  return randomToken()
}

/**
 * PKCE S256 pair. The verifier stays in an httpOnly cookie and is replayed on
 * the token exchange; Google only ever sees its hash on the way out, so an
 * intercepted authorization code cannot be redeemed by anyone else.
 */
export function pkcePair(): { verifier: string; challenge: string } {
  // base64url of 32 bytes is 43 chars of unreserved characters -- exactly the
  // RFC 7636 minimum, and every character is already legal in a verifier.
  const verifier = randomToken()
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

/**
 * Constant-time string compare that treats empty as "no value". Empty must
 * never match empty: a callback arriving with no state cookie and no state
 * parameter would otherwise sail through the CSRF check.
 */
export function safeCompare(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

/** Hono's setCookie options, minus the name and value. */
export interface CookieOptions {
  httpOnly: boolean
  secure: boolean
  sameSite: 'Lax'
  path: string
  maxAge: number
}

/**
 * `Secure` follows the public origin's scheme rather than being hardcoded:
 * hardcoded true means the cookie is silently dropped over http in dev, and
 * hardcoded false ships the session in clear text in production.
 */
function secureFor(publicApiUrl: string): boolean {
  return publicApiUrl.startsWith('https://')
}

export function sessionCookieOptions(publicApiUrl: string, ttlDays: number): CookieOptions {
  return {
    httpOnly: true,
    secure: secureFor(publicApiUrl),
    // Lax, not Strict: the callback is a cross-site top-level navigation from
    // Google, and Strict would withhold the cookie on the hop that sets it.
    sameSite: 'Lax',
    path: '/',
    maxAge: ttlDays * 86_400,
  }
}

/** Short-lived cookies carrying `state` and the PKCE verifier across the redirect. */
export function handshakeCookieOptions(publicApiUrl: string): CookieOptions {
  return { ...sessionCookieOptions(publicApiUrl, 0), maxAge: 600 }
}
