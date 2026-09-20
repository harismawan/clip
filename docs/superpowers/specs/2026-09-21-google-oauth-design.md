# Google Sign-In and Per-User Isolation — Design Spec

**Date:** 2026-09-21
**Status:** Approved, ready for implementation plan
**Scope:** Tier C — real auth, user accounts, per-user data isolation, quota

---

## 1. Problem

The login screen lies. `frontend/src/screens/LoginScreen.tsx` renders "Continue
with Google", "Continue with TikTok" and a "Send me a login link" email form.
All three call `signIn`, which is:

```ts
const signIn = useCallback(() => go('new'), [go])   // useSnipline.ts:396
```

A screen transition. There is no OAuth client, no `/api/auth/*` route, no users
table, no sessions table, and no `GOOGLE_CLIENT_ID` in the environment. Nothing
is broken; the feature was never built. The Tier A spec
(`2026-09-20-clip-pipeline-design.md` §2) deferred it explicitly: *"Out (deferred
to Tier C): Real auth, user accounts, per-user data isolation."*

What stands in for auth today is a single shared secret. `API_TOKEN` gates
`/api/*` through one middleware (`backend/src/auth.ts`), and its own docstring
states the limit: *"It is a gate, not identity: everyone holding the token shares
one pool of projects."*

That gate is now weaker than the docstring implies, for two reasons:

1. The SPA reads `VITE_API_TOKEN` at **build** time (`frontend/src/lib/api.ts:8`,
   `scripts/deploy.sh:179`), so the secret ships inside the JS bundle. Anyone who
   loads the page can read it.
2. As of 2026-09-20 the nginx `auth_basic` gate — which was the only thing
   actually protecting the deployment — was deliberately removed at the owner's
   request. `deploy/nginx/clip2.mhamzah.id` now documents the site as
   intentionally unauthenticated.

So `POST /api/jobs` is presently an open "download an arbitrary URL and burn
every core for 40 minutes" endpoint. This work closes that by replacing the
shared secret with real identity.

## 2. Scope

**In:**

- Google OAuth 2.0 authorization-code flow with PKCE, hand-rolled, no new dependency
- `users` and `sessions` tables; opaque session tokens in an httpOnly cookie
- `jobs.user_id`, and ownership scoping on every route that reads or mutates a job or clip
- Per-user quota: one active job, N jobs per rolling 24h
- Signed media URLs additionally require a session that owns the clip
- Deletion of the placeholder TikTok and magic-link UI
- Removal of `VITE_API_TOKEN` from the bundle and of the `?token=` SSE hack

**Out:**

- Any second identity provider. The TikTok button is deleted, not implemented.
- Billing, plans, usage surfaces beyond the quota error message
- Shareable public clip links (see §6.3 — decided against for now)
- Admin UI, user management, role or permission model
- Email anything. No verification, no notification, no magic links.
- Per-user S3 prefixes or storage quota. Disk is guarded globally as today.

## 3. Decisions

Settled during brainstorming, recorded because each one closes off a design branch:

| Decision | Choice | Consequence |
|---|---|---|
| Who may sign in | Anyone with a Google account | Quota is mandatory, not optional |
| Data isolation | Per-user projects | `jobs.user_id`, scoped queries everywhere |
| The 5 legacy jobs | Delete them | `user_id` is `NOT NULL` from the start; no backfill path, no nullable-forever schema |
| Signed media URLs | Require a session **and** ownership | A leaked URL is useless to a stranger; sharing deferred |
| OAuth implementation | Hand-rolled, zero new deps | ~150 lines; the hard part of this task is tenancy, which no library does for us |
| Session storage | Opaque token, row in Postgres | Revocable; a DB read happens anyway for quota and ownership, so statelessness buys nothing |

Rejected alternatives for the OAuth half: `@hono/oauth-providers` (a dependency
to replace the 40 best-documented lines on the internet, leaving users, sessions
and scoping to us regardless) and a full auth library such as better-auth or
Lucia (brings its own schema and migration story, colliding with
`shared/schema.ts` as the single source of truth that the worker also imports).

## 4. Data model

Two new tables in `shared/schema.ts`, the module both backend and worker import.

```
users     id           uuid pk default random
          google_sub   text unique notNull     -- Google's subject claim
          email        text notNull
          name         text
          picture_url  text
          created_at   timestamptz notNull default now
          last_seen_at timestamptz notNull default now

sessions  id           text pk                 -- sha256 hex of the cookie token
          user_id      uuid notNull → users(id) on delete cascade
          expires_at   timestamptz notNull
          created_at   timestamptz notNull default now
          index (user_id)
```

**`sessions.id` is a hash, never the token.** The cookie carries 32 random bytes
base64url-encoded; the database stores only its SHA-256. A database dump
therefore cannot be replayed as a live login.

**Identity keys on `google_sub`, not email.** A Google account's email address
can change, and matching on email would hand the old address's projects to
whoever later inherits that address. Email is stored for display only.

**Ownership hangs off one column:** `jobs.user_id uuid notNull → users(id)`.
Clips, renders and transcripts reach a user transitively
(`renders → clips → jobs → user`), so there is exactly one place to get scoping
right instead of four.

**`videos` and `transcripts` stay global, deliberately.** They are a URL-keyed
cache: `sources.ts:27` already reuses an existing row so re-analysing a URL does
not duplicate the row or strand its transcript, and transcription is the single
most expensive stage in the pipeline. Two users clipping the same YouTube link
should share it. The only fact observable across users is that a public URL was
analysed before; the cached metadata is what the platform serves anyone who asks.

### 4.1 Migration `0001`

Ordered, because the last step fails if the first is skipped:

1. **Purge the legacy renders from object storage.** The 5 existing jobs own ~10
   MinIO objects (`renders.s3_key`, `renders.thumb_key`), and SQL cannot reach
   S3. Run once, by hand, before migrating: a throwaway `bun -e` snippet that
   selects the keys and passes them to the existing `s3.deleteMany` helper. It is
   deliberately **not** a committed script — once `user_id` is `NOT NULL` this
   situation cannot recur. Disk is this box's binding constraint and these are
   video files, so they are worth reclaiming rather than orphaning.
2. `DELETE FROM jobs` — clips, renders and transcripts follow by cascade.
3. Create `users` and `sessions`.
4. `ALTER TABLE jobs ADD COLUMN user_id uuid NOT NULL REFERENCES users(id)`.

Verified counts before writing this spec: 3 videos, 5 jobs, 10 clips, 10 renders.
Videos survive — they are the shared cache of §4, not user data.

## 5. OAuth flow and sessions

### 5.1 Routes

A new `backend/src/routes/auth.ts`, mounted **before** the session middleware:

```
GET  /api/auth/google           302 → Google consent.
                                Sets oauth_state and oauth_verifier cookies
                                (httpOnly, SameSite=Lax, Max-Age 600).

GET  /api/auth/google/callback  Verify state against the cookie FIRST.
                                Exchange code + PKCE verifier server-to-server.
                                Upsert user by google_sub; touch last_seen_at.
                                Insert session; set clip_session; 302 → /.
                                On any failure: 302 → /?error=<code>.

GET  /api/auth/me               {id, email, name, pictureUrl} or 401.

POST /api/auth/logout           DELETE the session row; clear the cookie; 204.
```

Scopes requested: `openid email profile`. These are Google's non-sensitive
scopes, so the consent screen can be published without Google's review process —
which is the reason not to ask for anything more.

### 5.2 Why the `id_token` needs no JWKS verification

The token arrives in the body of a direct server-to-server `POST` to Google's
token endpoint over TLS, not through the browser. The channel already
authenticates the issuer, so the claims (`sub`, `email`, `name`, `picture`) can
be decoded without fetching Google's signing keys. Signature verification is
required only for an `id_token` that reached us via an untrusted party — which
never happens in the authorization-code flow.

### 5.3 What must not be skipped

`state` is compared against its cookie before the code is exchanged. That
comparison is the CSRF defence for the callback, and omitting it is the standard
way these integrations are broken. PKCE's `code_verifier` likewise rides in an
httpOnly cookie and is sent with the exchange; a mismatch aborts the login.

Both cookies are `SameSite=Lax` rather than `Strict`: they are read on a
cross-site top-level redirect back from Google, and `Strict` would withhold them.

### 5.4 Session cookie

`clip_session`: httpOnly, `SameSite=Lax`, `Path=/`, `Max-Age` from
`SESSION_TTL_DAYS` (default 30), and `Secure` **conditional on `PUBLIC_API_URL`
being https**. Hardcoding `Secure` silently breaks local development over http;
omitting it in production would be a real vulnerability.

### 5.5 `requireSession` replaces `requireToken`

`backend/src/auth.ts` keeps its shape — one `MiddlewareHandler` mounted at
`app.use('/api/*')` — but hashes the cookie, does one indexed lookup joined to
`users`, rejects a missing or expired session with 401, and puts the user on the
Hono context for handlers.

**This deletes the `?token=` query-parameter branch** (`auth.ts:25`). It exists
only because `EventSource` cannot set an `Authorization` header, which forced the
shared secret into the URL and from there into nginx access logs and `Referer`
headers. Cookies are sent by `EventSource` natively, so the hack disappears as a
side effect of doing auth properly.

`API_TOKEN` survives in exactly one role: the HMAC key for signed media URLs
(`shared/mediaToken.ts`, `mappers.ts:50`). It stops being an access credential
and stops being baked into the bundle. Its `env.ts` comment is rewritten to say
so, since a stale comment claiming it gates the API would be worse than none.

### 5.6 Local development

A `SameSite=Lax` cookie is **not** sent on a cross-origin `fetch` from
`localhost:5173` to `localhost:3014`. Rather than weaken the cookie to
`SameSite=None`, add a Vite dev proxy for `/api` so development sees a single
origin exactly as production does. `frontend/src/lib/api.ts` already defaults
`BASE` to `''` and calls a bare `/api`, so this needs no client change — and it
makes the CORS configuration vestigial rather than load-bearing.

## 6. Authorization

### 6.1 Two helpers, ten call sites

Ten handlers currently trust whoever holds the token. Rather than repeat
`eq(jobs.userId, …)` at each — where the eleventh, added later, silently forgets
— a new `backend/src/ownership.ts` becomes the only way to reach a job or clip:

```ts
ownedJob(userId, jobId)      → job row | null
ownedClips(userId, clipIds)  → only the clips that user owns
```

Call sites to change:

| File | Handler | Change |
|---|---|---|
| `routes/jobs.ts` | `POST /` | stamp `user_id`; quota check (§7) |
| | `GET /:id` | `ownedJob` |
| | `GET /:id/events` | `ownedJob` |
| | `POST /:id/cancel` | `ownedJob` |
| | `POST /:id/regenerate` | `ownedJob` |
| | `GET /` (projects) | filter: `and(status='completed', user_id=me)` |
| `routes/clips.ts` | `GET /:id/download` | ownership via `clip.jobId` |
| | `POST /:id/redo` | ownership via `clip.jobId` |
| | `POST /api/downloads` | `ownedClips` over the request's `clipIds` |
| `routes/media.ts` | `GET /:file` | HMAC **and** session **and** ownership |

`POST /api/downloads` deserves specific attention: it takes an array of clip ids
in a JSON body and currently zips whatever it is given
(`clips.ts:87`, `inArray(clips.id, clipIds)`). It is the easiest endpoint to
forget and the one that leaks most per request.

### 6.2 404, not 403

A job belonging to another user returns **404**. A 403 confirms the id exists,
which tells an attacker that a given uuid is somebody's job.

### 6.3 Media

`routes/media.ts` keeps its HMAC signature check and adds session + ownership. It
stays mounted outside `requireSession` because it needs its own failure
handling — a bare 401 for an `<img>` would surface to the user as "link expired"
— so it validates the cookie itself and returns 404 for a clip the session does
not own.

Same-origin `<img>`, `<video>` and `<a download>` requests send cookies
automatically, so the app is unaffected. The cost is that a clip URL pasted to
someone without an account no longer works. Explicit share links are deferred,
not denied: if wanted later, a short-lived per-clip share token is a separate
feature rather than a hole in this one.

## 7. Quota

Enforced in `POST /api/jobs` before the insert, as two counts:

```
active: jobs where user_id = me and status not terminal
        ≥ 1  → 409 "You already have a clip job running. Wait for it to finish."

daily:  jobs where user_id = me and created_at > now() - interval '24 hours'
        ≥ QUOTA_JOBS_PER_DAY (default 3)
             → 429 "Daily limit reached. Try again tomorrow."
```

409 for the concurrency conflict and 429 for the rate cap: different problems
with different remedies, so different status codes. Both use the existing error
shape, which `ApiError` already surfaces verbatim in a toast, so the frontend
needs no special case.

Worker concurrency is 1 (Tier A spec §3: 4 cores, no GPU). "One active job per
user" is therefore what stops a queue of strangers becoming a ten-hour wait for
everyone behind them. The daily cap is what stops one signup consuming the box
all day.

Global disk and queue guards stay exactly as they are; this is per-user
fairness, not a replacement for the preflight disk check.

## 8. Frontend

`lib/api.ts` — delete `TOKEN` and the `Authorization` header; drop `?token=` from
the `EventSource` URL (`api.ts:99-109`); add `auth.me()` and `auth.logout()`. A
401 from any call is treated as "session expired" and returns the app to the
login screen, so an expired cookie does not present as a broken app.

`screens/LoginScreen.tsx` — the Google button becomes a real link to
`/api/auth/google`. The TikTok button and the email/magic-link form are
**deleted**: they advertise flows that do not exist and will not after this work.
Renders `?error=` from a failed callback.

`state/useSnipline.ts` — `signIn` (line 396) becomes the redirect rather than
`go('new')`; `signOut` calls the endpoint before resetting local state.

App boot calls `auth.me()`, which requires a new `'booting'` screen state that
renders nothing. Without it every reload flashes the login screen before landing
on the user's projects.

## 9. Environment and deploy

| Variable | Default | Note |
|---|---|---|
| `GOOGLE_CLIENT_ID` | — | Boot fails without it |
| `GOOGLE_CLIENT_SECRET` | — | Boot fails without it |
| `SESSION_TTL_DAYS` | `30` | Cookie and `sessions.expires_at` |
| `QUOTA_JOBS_PER_DAY` | `3` | §7 |

The redirect URI is **derived** from `PUBLIC_API_URL`
(`${PUBLIC_API_URL}/api/auth/google/callback`) rather than configured separately,
so the two cannot disagree. `env.ts` fails the boot when the Google pair is
missing, for the reason its existing comment gives about `API_TOKEN`: a missing
credential must stop the boot, never fall back to "no auth".

`scripts/deploy.sh` — drop `VITE_API_TOKEN` from the frontend build (line 179),
add the Google pair to preflight, and add one verification: `GET /api/projects`
without a cookie must return **401**. That restores the "the gate is closed"
assertion removed on 2026-09-20, this time proving the real gate rather than
nginx's.

nginx needs no change. `/api/` is already proxied as a single prefix and passes
cookies through untouched.

### 9.1 Manual setup, outside this repo

Creating the OAuth client in Google Cloud Console cannot be scripted from here:

1. New OAuth 2.0 Client ID, type **Web application**.
2. Authorized redirect URI: `https://clip2.mhamzah.id/api/auth/google/callback`
   — exact match, no trailing slash.
3. OAuth consent screen: External, published. No Google review needed for
   `openid email profile`.
4. Put the id and secret in the root `.env`, which `deploy.sh` never touches.

**Do not reuse the credentials in `/home/wildandev/repo/clipper/.env`.** The Tier
A spec §12.2 flagged those as live-looking and due for rotation. Create a fresh
client.

## 10. Testing

**Unit** (`bun test`, no network, runs by default):

- Session token: hash/verify round trip; a tampered token rejected
- Session expiry boundary — a session one second past `expires_at` is rejected
- `state` mismatch aborts the callback
- PKCE verifier mismatch aborts the token exchange
- `ownedJob` returns null for another user's job id
- Quota arithmetic: the 24h rolling boundary, and the active-job edge at exactly 1
- Cookie flags: `Secure` present for an https `PUBLIC_API_URL`, absent for http

**Manual**, because the Google round trip cannot be exercised without mocking
Google, and mocking it would test the mock:

1. Sign in with Google → lands on the New Video screen
2. Reload → still signed in, projects listed
3. Log out → login screen; the session row is gone
4. Sign in as a **second** Google account → empty project list, and a direct
   `GET /api/jobs/<first account's job id>` returns 404
5. A media URL from account A, opened while signed in as B → 404
6. Create two jobs back to back → the second is refused with 409
7. `curl https://clip2.mhamzah.id/api/projects` with no cookie → 401

## 11. Risks

| Risk | Mitigation |
|---|---|
| Open signup on a 4-core box | Per-user quota (§7); global disk guard unchanged |
| A forgotten scope check leaks another user's data | All access goes through two helpers (§6.1); the table in §6.1 is the complete call-site list |
| `SameSite=Lax` breaks the dev cross-origin fetch | Vite dev proxy (§5.6), not a weakened cookie |
| Hardcoded `Secure` breaks dev; missing `Secure` is a hole | Conditional on `PUBLIC_API_URL` scheme (§5.4) |
| Legacy S3 objects orphaned by the row delete | Purge step ordered before the SQL (§4.1) |
| Google consent screen stuck in test mode, capped at 100 users | Only non-sensitive scopes requested, so it can be published without review (§5.1) |
| Session cookie theft via XSS | httpOnly; no token in JS at all after `VITE_API_TOKEN` is removed |

## 12. Deferred

- Shareable public clip links (short-lived per-clip token)
- A second provider (TikTok, Apple, email magic links)
- Admin surfaces: user list, per-user quota override, ban
- Session list and "log out everywhere" UI — the `sessions.user_id` index exists
  to make it one `DELETE` when wanted
- Per-user storage quota and S3 prefixes
- Refresh tokens. Nothing here calls a Google API after login, so there is
  nothing to refresh; a 30-day session simply expires.
