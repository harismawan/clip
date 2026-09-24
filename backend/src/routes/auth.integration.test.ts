/**
 * The OAuth routes as mounted. Needs a validated environment (the module reads
 * GOOGLE_CLIENT_ID and PUBLIC_API_URL at import), but touches neither Google nor
 * the database: every case here is rejected before the token exchange.
 *
 *   GOOGLE_CLIENT_ID=x GOOGLE_CLIENT_SECRET=x RUN_DB_TESTS=1 \
 *     bun --env-file=../.env test routes/auth
 */
import { test, expect, beforeAll } from 'bun:test'

const ENABLED = process.env.RUN_DB_TESTS === '1'
const maybe = ENABLED ? test : test.skip

let authRoutes: typeof import('./auth.ts')['authRoutes']

beforeAll(async () => {
  if (!ENABLED) return
  ;({ authRoutes } = await import('./auth.ts'))
})

/** Parse a Set-Cookie header list into a name -> value map. */
function cookies(res: Response): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(';')
    const eq = pair.indexOf('=')
    out[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return out
}

maybe('GET /google redirects to Google', async () => {
  const res = await authRoutes.request('/google')
  expect(res.status).toBe(302)
  expect(res.headers.get('location')).toStartWith('https://accounts.google.com/o/oauth2/v2/auth')
})

maybe('GET /google plants the state and verifier cookies it will check later', async () => {
  const res = await authRoutes.request('/google')
  const set = cookies(res)
  expect(set.oauth_state).toBeTruthy()
  expect(set.oauth_verifier).toBeTruthy()
})

maybe('the state in the URL is the state in the cookie', async () => {
  const res = await authRoutes.request('/google')
  const url = new URL(res.headers.get('location')!)
  expect(url.searchParams.get('state')).toBe(cookies(res).oauth_state)
})

maybe('the challenge in the URL is not the verifier in the cookie', async () => {
  const res = await authRoutes.request('/google')
  const url = new URL(res.headers.get('location')!)
  expect(url.searchParams.get('code_challenge')).not.toBe(cookies(res).oauth_verifier)
})

maybe('a callback with a forged state is refused without contacting Google', async () => {
  const res = await authRoutes.request('/google/callback?code=abc&state=forged', {
    headers: { Cookie: 'oauth_state=the-real-one; oauth_verifier=v' },
  })
  expect(res.status).toBe(302)
  expect(res.headers.get('location')).toBe('/login?error=state')
})

maybe('a callback with no state cookie is refused, not treated as a match', async () => {
  const res = await authRoutes.request('/google/callback?code=abc&state=')
  expect(res.headers.get('location')).toBe('/login?error=state')
})

maybe('a callback with no code is refused', async () => {
  const res = await authRoutes.request('/google/callback?state=s', {
    headers: { Cookie: 'oauth_state=s; oauth_verifier=v' },
  })
  expect(res.headers.get('location')).toBe('/login?error=code')
})

maybe('a callback carrying Google\'s own error is passed through to the UI', async () => {
  const res = await authRoutes.request('/google/callback?error=access_denied')
  expect(res.headers.get('location')).toBe('/login?error=denied')
})

maybe('the handshake cookies are cleared once the callback has read them', async () => {
  const res = await authRoutes.request('/google/callback?code=abc&state=forged', {
    headers: { Cookie: 'oauth_state=the-real-one; oauth_verifier=v' },
  })
  const set = cookies(res)
  expect(set.oauth_state).toBe('')
  expect(set.oauth_verifier).toBe('')
})
