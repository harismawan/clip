import { test, expect, describe } from 'bun:test'
import { googleAuthUrl, parseIdToken } from './oauth.ts'

const CLIENT = '1234.apps.googleusercontent.com'
const REDIRECT = 'https://clip2.mhamzah.id/api/auth/google/callback'

/** Build an unsigned JWT with the given payload -- signature is never checked. */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'RS256' })}.${b64(payload)}.fake-signature`
}

const validPayload = {
  iss: 'https://accounts.google.com',
  aud: CLIENT,
  sub: '110000000000000000001',
  email: 'someone@gmail.com',
  email_verified: true,
  name: 'Someone',
  picture: 'https://lh3.googleusercontent.com/a/x',
  exp: Math.floor(Date.now() / 1000) + 3600,
}

describe('googleAuthUrl', () => {
  const url = () =>
    new URL(
      googleAuthUrl({
        clientId: CLIENT,
        redirectUri: REDIRECT,
        state: 'the-state',
        challenge: 'the-challenge',
      }),
    )

  test('points at Google', () => {
    expect(url().origin).toBe('https://accounts.google.com')
  })

  test('asks for an authorization code', () => {
    expect(url().searchParams.get('response_type')).toBe('code')
  })

  test('requests only the non-sensitive scopes, so no Google review is needed', () => {
    expect(url().searchParams.get('scope')).toBe('openid email profile')
  })

  test('carries the state, which the callback compares against its cookie', () => {
    expect(url().searchParams.get('state')).toBe('the-state')
  })

  test('uses PKCE with S256, never plain', () => {
    expect(url().searchParams.get('code_challenge')).toBe('the-challenge')
    expect(url().searchParams.get('code_challenge_method')).toBe('S256')
  })

  test('sends the exact redirect_uri Google has registered', () => {
    expect(url().searchParams.get('redirect_uri')).toBe(REDIRECT)
  })
})

describe('parseIdToken', () => {
  test('returns the claims this app uses', () => {
    const claims = parseIdToken(jwt(validPayload), CLIENT)
    expect(claims).toEqual({
      sub: '110000000000000000001',
      email: 'someone@gmail.com',
      name: 'Someone',
      picture: 'https://lh3.googleusercontent.com/a/x',
    })
  })

  test('a token minted for another client is rejected', () => {
    const other = jwt({ ...validPayload, aud: 'someone-elses-client.apps.googleusercontent.com' })
    expect(() => parseIdToken(other, CLIENT)).toThrow(/audience/i)
  })

  test('a token from another issuer is rejected', () => {
    const evil = jwt({ ...validPayload, iss: 'https://evil.example.com' })
    expect(() => parseIdToken(evil, CLIENT)).toThrow(/issuer/i)
  })

  test('the https form of Google issuer is accepted', () => {
    expect(() => parseIdToken(jwt({ ...validPayload, iss: 'accounts.google.com' }), CLIENT)).not.toThrow()
  })

  test('an expired token is rejected', () => {
    const stale = jwt({ ...validPayload, exp: Math.floor(Date.now() / 1000) - 60 })
    expect(() => parseIdToken(stale, CLIENT)).toThrow(/expired/i)
  })

  test('a token with no subject is rejected -- sub is the identity key', () => {
    const { sub, ...rest } = validPayload
    expect(() => parseIdToken(jwt(rest), CLIENT)).toThrow(/subject/i)
  })

  test('a token with no email is rejected', () => {
    const { email, ...rest } = validPayload
    expect(() => parseIdToken(jwt(rest), CLIENT)).toThrow(/email/i)
  })

  test('malformed input is rejected rather than crashing the callback', () => {
    expect(() => parseIdToken('not-a-jwt', CLIENT)).toThrow()
    expect(() => parseIdToken('', CLIENT)).toThrow()
    expect(() => parseIdToken('a.b.c', CLIENT)).toThrow()
  })

  test('optional profile fields become null rather than undefined', () => {
    const bare = { ...validPayload }
    delete (bare as Record<string, unknown>).name
    delete (bare as Record<string, unknown>).picture
    const claims = parseIdToken(jwt(bare), CLIENT)
    expect(claims.name).toBeNull()
    expect(claims.picture).toBeNull()
  })
})
