import { test, expect, describe } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  newSessionToken,
  hashToken,
  isExpired,
  expiryFrom,
  pkcePair,
  randomState,
  safeCompare,
  sessionCookieOptions,
  handshakeCookieOptions,
} from './session.ts'

describe('session tokens', () => {
  test('the id stored in the database is the hash, not the token', () => {
    const { token, id } = newSessionToken()
    expect(id).not.toBe(token)
    expect(id).toBe(hashToken(token))
  })

  test('hashing is deterministic, so a returning cookie finds its row', () => {
    const { token, id } = newSessionToken()
    expect(hashToken(token)).toBe(id)
  })

  test('a tampered token does not hash to the stored id', () => {
    const { token, id } = newSessionToken()
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`
    expect(hashToken(tampered)).not.toBe(id)
  })

  test('two sessions never collide', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newSessionToken().id))
    expect(ids.size).toBe(100)
  })

  test('the token is url-safe, so it survives a Set-Cookie round trip', () => {
    const { token } = newSessionToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    // 32 random bytes base64url-encoded, unpadded.
    expect(token.length).toBe(43)
  })
})

describe('session expiry', () => {
  const now = new Date('2026-09-21T12:00:00Z')

  test('a session in the future is live', () => {
    expect(isExpired(new Date('2026-09-21T12:00:01Z'), now)).toBe(false)
  })

  test('a session one second past its expiry is rejected', () => {
    expect(isExpired(new Date('2026-09-21T11:59:59Z'), now)).toBe(true)
  })

  test('the exact expiry instant is rejected, not honoured', () => {
    expect(isExpired(now, now)).toBe(true)
  })

  test('expiryFrom is the configured number of days out', () => {
    expect(expiryFrom(30, now)).toEqual(new Date('2026-10-21T12:00:00Z'))
  })
})

describe('PKCE', () => {
  test('the challenge is the S256 hash of the verifier, which is what Google checks', () => {
    const { verifier, challenge } = pkcePair()
    const expected = createHash('sha256').update(verifier).digest('base64url')
    expect(challenge).toBe(expected)
  })

  test('the verifier obeys RFC 7636: 43-128 unreserved characters', () => {
    const { verifier } = pkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/)
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(verifier.length).toBeLessThanOrEqual(128)
  })

  test('every login gets a fresh verifier', () => {
    expect(pkcePair().verifier).not.toBe(pkcePair().verifier)
  })
})

describe('state comparison', () => {
  test('a matching state passes', () => {
    const s = randomState()
    expect(safeCompare(s, s)).toBe(true)
  })

  test('a forged state fails -- this is the CSRF defence', () => {
    expect(safeCompare(randomState(), randomState())).toBe(false)
  })

  test('an absent cookie cannot be matched by an empty query parameter', () => {
    expect(safeCompare('', '')).toBe(false)
  })

  test('a differing length fails without throwing', () => {
    expect(safeCompare('abc', 'abcd')).toBe(false)
  })
})

describe('session cookie flags', () => {
  test('production over https is Secure', () => {
    expect(sessionCookieOptions('https://clip2.mhamzah.id', 30).secure).toBe(true)
  })

  test('local development over http is not Secure, or the cookie is never stored', () => {
    expect(sessionCookieOptions('http://localhost:3014', 30).secure).toBe(false)
  })

  test('always httpOnly, so XSS cannot read the session', () => {
    expect(sessionCookieOptions('https://clip2.mhamzah.id', 30).httpOnly).toBe(true)
  })

  test('SameSite is Lax, not Strict -- Strict withholds it on the return from Google', () => {
    expect(sessionCookieOptions('https://clip2.mhamzah.id', 30).sameSite).toBe('Lax')
  })

  test('maxAge is the TTL in seconds', () => {
    expect(sessionCookieOptions('https://clip2.mhamzah.id', 30).maxAge).toBe(30 * 86400)
  })

  test('scoped to the whole site so /api and / share it', () => {
    expect(sessionCookieOptions('https://clip2.mhamzah.id', 30).path).toBe('/')
  })
})

describe('handshake cookie flags', () => {
  test('state and verifier live for ten minutes, not thirty days', () => {
    expect(handshakeCookieOptions('https://clip2.mhamzah.id').maxAge).toBe(600)
  })

  test('httpOnly, so the page cannot read the verifier', () => {
    expect(handshakeCookieOptions('https://clip2.mhamzah.id').httpOnly).toBe(true)
  })

  test('Lax, because it must survive the cross-site redirect back from Google', () => {
    expect(handshakeCookieOptions('https://clip2.mhamzah.id').sameSite).toBe('Lax')
  })
})
