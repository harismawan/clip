/**
 * Google sign-in.
 *
 * Two public routes do the handshake and two gated ones report and end it. The
 * decisions that must be right (URL parameters, claim checks, cookie flags) live
 * in oauth.ts and session.ts; this file is the IO around them.
 *
 * Failures redirect to `/?error=<code>` rather than returning JSON: the browser
 * arrives here by top-level navigation, so a JSON body would be shown as a bare
 * page of text instead of the login screen saying what went wrong.
 */
import { Hono } from 'hono'
import { setCookie, getCookie, deleteCookie } from 'hono/cookie'
import { env, oauthRedirectUri } from '../env.ts'
import {
  randomState,
  pkcePair,
  safeCompare,
  sessionCookieOptions,
  handshakeCookieOptions,
  hashToken,
} from '../session.ts'
import { googleAuthUrl, parseIdToken, TOKEN_ENDPOINT } from '../oauth.ts'
import { upsertGoogleUser, createSession, deleteSession } from '../sessionStore.ts'
import { SESSION_COOKIE } from '../auth.ts'

const STATE_COOKIE = 'oauth_state'
const VERIFIER_COOKIE = 'oauth_verifier'

export const authRoutes = new Hono()

/** Start the flow. */
authRoutes.get('/google', (c) => {
  const state = randomState()
  const { verifier, challenge } = pkcePair()

  const opts = handshakeCookieOptions(env.PUBLIC_API_URL)
  setCookie(c, STATE_COOKIE, state, opts)
  setCookie(c, VERIFIER_COOKIE, verifier, opts)

  return c.redirect(
    googleAuthUrl({
      clientId: env.GOOGLE_CLIENT_ID,
      redirectUri: oauthRedirectUri,
      state,
      challenge,
    }),
    302,
  )
})

/** Finish the flow. */
authRoutes.get('/google/callback', async (c) => {
  const opts = handshakeCookieOptions(env.PUBLIC_API_URL)
  const state = getCookie(c, STATE_COOKIE) ?? ''
  const verifier = getCookie(c, VERIFIER_COOKIE) ?? ''

  // Read once, then clear: these are single-use, and leaving them set lets a
  // stale verifier be replayed against a later code.
  deleteCookie(c, STATE_COOKIE, opts)
  deleteCookie(c, VERIFIER_COOKIE, opts)

  // The user declined at Google's consent screen, or Google refused.
  if (c.req.query('error')) return c.redirect('/?error=denied', 302)

  // THE CSRF CHECK. safeCompare treats empty as no value, so a callback with
  // neither cookie nor parameter cannot match itself into a session.
  if (!safeCompare(c.req.query('state') ?? '', state)) {
    return c.redirect('/?error=state', 302)
  }

  const code = c.req.query('code') ?? ''
  if (!code) return c.redirect('/?error=code', 302)

  try {
    const claims = parseIdToken(await exchangeCode(code, verifier), env.GOOGLE_CLIENT_ID)
    const user = await upsertGoogleUser(claims)
    const { token } = await createSession(user.id, env.SESSION_TTL_DAYS)
    setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(env.PUBLIC_API_URL, env.SESSION_TTL_DAYS))
    return c.redirect('/', 302)
  } catch (e) {
    console.error('[auth] callback failed:', (e as Error).message)
    return c.redirect('/?error=exchange', 302)
  }
})

/**
 * Swap the authorization code for tokens. Server-to-server over TLS with the
 * client secret, which is why the returned id_token needs no signature check
 * (see oauth.ts).
 */
async function exchangeCode(code: string, verifier: string): Promise<string> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: oauthRedirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  })

  if (!res.ok) {
    // Google's body names the real cause (redirect_uri_mismatch, invalid_client,
    // invalid_grant); without it this is an unactionable 400.
    throw new Error(`token exchange failed (${res.status}): ${await res.text()}`)
  }

  const body = (await res.json()) as { id_token?: string }
  if (!body.id_token) throw new Error('token response carried no id_token')
  return body.id_token
}

/** Mounted behind requireSession: who am I, and end this. */
export const authSessionRoutes = new Hono()

authSessionRoutes.get('/me', (c) => c.json(c.get('user')))

authSessionRoutes.post('/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE)
  if (token) await deleteSession(hashToken(token))
  deleteCookie(c, SESSION_COOKIE, sessionCookieOptions(env.PUBLIC_API_URL, env.SESSION_TTL_DAYS))
  return c.body(null, 204)
})
