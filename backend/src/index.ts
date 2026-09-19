import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { env, corsOrigins } from './env.ts'
import { requireToken } from './auth.ts'
import { startQueue } from './queue.ts'
import { ensureListening } from './events.ts'
import { sources } from './routes/sources.ts'
import { jobsRoutes } from './routes/jobs.ts'
import { clipsRoutes, downloadsRoutes } from './routes/clips.ts'
import { mediaRoutes } from './routes/media.ts'
import { pool } from './db/index.ts'

const app = new Hono()

app.use('*', logger())
app.use(
  '/api/*',
  cors({
    origin: corsOrigins,
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  }),
)

/** Unauthenticated: a health check that needs a secret is useless to a probe. */
app.get('/api/health', async (c) => {
  try {
    await pool.query('select 1')
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 503)
  }
})

/**
 * Media is mounted BEFORE the token middleware: its URLs carry their own HMAC
 * signature, because <img> and <a download> cannot send an Authorization header.
 */
app.route('/api/media', mediaRoutes)

app.use('/api/*', requireToken)

app.route('/api/sources', sources)
app.route('/api/jobs', jobsRoutes)
app.route('/api/projects', jobsRoutes) // GET / lists completed jobs
app.route('/api/clips', clipsRoutes)
app.route('/api/downloads', downloadsRoutes)

/**
 * Turn thrown errors into JSON. Messages from this codebase are written for the
 * user ("That video is too short to clip"), so they are surfaced; anything else
 * is logged and replaced, to avoid leaking stack traces or ffmpeg dumps.
 */
app.onError((err, c) => {
  console.error('[api]', err)
  const safe = err instanceof Error && err.message.length < 300 ? err.message : 'Something broke.'
  return c.json({ error: safe }, 500)
})

app.notFound((c) => c.json({ error: 'Not found' }, 404))

await startQueue()
await ensureListening()

console.log(`api listening on http://${env.HOST}:${env.PORT}`)

export default {
  port: env.PORT,
  hostname: env.HOST,
  fetch: app.fetch,
  // A 40-minute SSE stream must not be reaped by Bun's request timeout.
  idleTimeout: 255,
}
