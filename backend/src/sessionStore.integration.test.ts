/**
 * Session and user persistence, against a real Postgres.
 *
 * The Google pair is dummied rather than read from .env: these tests never
 * reach Google, and the real .env should not carry placeholder credentials.
 *
 *   GOOGLE_CLIENT_ID=x GOOGLE_CLIENT_SECRET=x RUN_DB_TESTS=1 \
 *     bun --env-file=../.env test sessionStore
 */
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'

const ENABLED = process.env.RUN_DB_TESTS === '1'
const maybe = ENABLED ? test : test.skip

let db: typeof import('./db/index.ts')['db']
let users: typeof import('./db/index.ts')['users']
let sessions: typeof import('./db/index.ts')['sessions']
let store: typeof import('./sessionStore.ts')
let hashToken: typeof import('./session.ts')['hashToken']

const stamp = Date.now()
const sub = `test-store-${stamp}`
const created: string[] = []

beforeAll(async () => {
  if (!ENABLED) return
  ;({ db, users, sessions } = await import('./db/index.ts'))
  store = await import('./sessionStore.ts')
  ;({ hashToken } = await import('./session.ts'))
})

afterAll(async () => {
  if (!ENABLED) return
  if (created.length) await db.delete(users).where(inArray(users.id, created))
})

maybe('a first sign-in creates the user', async () => {
  const user = await store.upsertGoogleUser({
    sub,
    email: 'store@test.invalid',
    name: 'Store Test',
    picture: 'https://test.invalid/a.jpg',
  })
  created.push(user.id)
  expect(user.email).toBe('store@test.invalid')
  expect(user.name).toBe('Store Test')
})

maybe('a second sign-in with the same Google subject reuses the row', async () => {
  const again = await store.upsertGoogleUser({
    sub,
    email: 'store@test.invalid',
    name: 'Store Test',
    picture: null,
  })
  expect(again.id).toBe(created[0])
  const rows = await db.select().from(users).where(eq(users.googleSub, sub))
  expect(rows).toHaveLength(1)
})

maybe('a changed email updates the existing user rather than duplicating them', async () => {
  const moved = await store.upsertGoogleUser({
    sub,
    email: 'moved@test.invalid',
    name: 'Store Test',
    picture: null,
  })
  expect(moved.id).toBe(created[0])
  expect(moved.email).toBe('moved@test.invalid')
})

maybe('a created session is found by the hash of its token', async () => {
  const { token, expiresAt } = await store.createSession(created[0], 30)
  const found = await store.lookupSession(hashToken(token))
  expect(found?.user.id).toBe(created[0])
  expect(found?.expiresAt.getTime()).toBeCloseTo(expiresAt.getTime(), -3)
})

maybe('the raw token is never what is stored', async () => {
  const { token } = await store.createSession(created[0], 30)
  const rows = await db.select().from(sessions).where(eq(sessions.id, token))
  expect(rows).toEqual([])
})

maybe('an unknown session id resolves to nothing', async () => {
  expect(await store.lookupSession(hashToken('never-issued'))).toBeNull()
})

maybe('deleting a session makes it unusable', async () => {
  const { token } = await store.createSession(created[0], 30)
  const id = hashToken(token)
  expect(await store.lookupSession(id)).not.toBeNull()
  await store.deleteSession(id)
  expect(await store.lookupSession(id)).toBeNull()
})

maybe('deleting the user removes their sessions', async () => {
  const doomed = await store.upsertGoogleUser({
    sub: `test-doomed-${stamp}`,
    email: 'doomed@test.invalid',
    name: null,
    picture: null,
  })
  const { token } = await store.createSession(doomed.id, 30)
  await db.delete(users).where(eq(users.id, doomed.id))
  expect(await store.lookupSession(hashToken(token))).toBeNull()
})
