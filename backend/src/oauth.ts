/**
 * Google OAuth mechanics, kept pure so the parts that must be exactly right --
 * the consent URL's parameters and the id_token's claims -- are testable without
 * a network, a browser or a live Google client.
 *
 * The route in routes/auth.ts does the IO; everything decided here is a function
 * of its arguments.
 */
import type { GoogleClaims } from './sessionStore.ts'

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

/** Google mints id_tokens with either spelling of its issuer. */
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

export interface AuthUrlParams {
  clientId: string
  redirectUri: string
  state: string
  challenge: string
}

export function googleAuthUrl({ clientId, redirectUri, state, challenge }: AuthUrlParams): string {
  const url = new URL(AUTH_ENDPOINT)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  // Non-sensitive scopes only: they are what lets the consent screen be
  // published without Google's review process.
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  // Let someone pick a different account instead of being silently signed in as
  // whoever the browser last used.
  url.searchParams.set('prompt', 'select_account')
  return url.toString()
}

/**
 * Read the claims out of an id_token.
 *
 * The signature is deliberately not verified, and that is not a shortcut: this
 * token arrives in the body of our own server-to-server POST to Google's token
 * endpoint over TLS, so the channel already authenticates the issuer. Signature
 * verification matters for an id_token that reached us via an untrusted party,
 * which never happens in the authorization-code flow.
 *
 * The claims are still checked. A mismatched audience or issuer means the token
 * was not minted for this client, which is a misconfiguration worth failing on
 * rather than trusting.
 */
export function parseIdToken(idToken: string, clientId: string, now = new Date()): GoogleClaims {
  const parts = idToken.split('.')
  if (parts.length !== 3) throw new Error('Malformed id_token')

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    throw new Error('Malformed id_token payload')
  }
  if (!payload || typeof payload !== 'object') throw new Error('Malformed id_token payload')

  if (payload.aud !== clientId) throw new Error('id_token audience does not match this client')
  if (typeof payload.iss !== 'string' || !GOOGLE_ISSUERS.includes(payload.iss)) {
    throw new Error('id_token issuer is not Google')
  }
  if (typeof payload.exp === 'number' && payload.exp * 1000 <= now.getTime()) {
    throw new Error('id_token has expired')
  }
  if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('id_token has no subject')
  if (typeof payload.email !== 'string' || !payload.email) throw new Error('id_token has no email')

  return {
    sub: payload.sub,
    email: payload.email,
    name: typeof payload.name === 'string' ? payload.name : null,
    picture: typeof payload.picture === 'string' ? payload.picture : null,
  }
}
