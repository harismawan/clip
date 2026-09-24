/**
 * One dedicated Postgres connection running LISTEN, fanned out to SSE
 * subscribers. A connection per browser would exhaust max_connections fast;
 * a poll loop would add latency and load for no gain.
 */
import pg from 'pg'
import { env } from './env.ts'
import { NOTIFY_CHANNEL, decodeProgress } from '../../shared/progress.ts'
import { API_APP_NAME } from '../../shared/queue.ts'
import type { ProgressEvent } from '../../shared/types.ts'

type Listener = (e: ProgressEvent) => void

const listeners = new Map<string, Set<Listener>>()
let client: pg.Client | null = null
let connecting: Promise<void> | null = null

async function connect(): Promise<void> {
  const c = new pg.Client({ connectionString: env.DATABASE_URL, application_name: API_APP_NAME })

  c.on('notification', (msg) => {
    if (msg.channel !== NOTIFY_CHANNEL || !msg.payload) return
    const event = decodeProgress(msg.payload)
    if (!event) return
    for (const fn of listeners.get(event.jobId) ?? []) fn(event)
  })

  // A dropped LISTEN connection is silent: no error surfaces to the browser,
  // progress simply stops forever. Reconnect rather than degrade.
  c.on('error', (err) => {
    console.error('[events] listen connection error, reconnecting:', err.message)
    client = null
    connecting = null
    setTimeout(() => void ensureListening(), 1000)
  })

  await c.connect()
  await c.query(`LISTEN ${NOTIFY_CHANNEL}`)
  client = c
}

export async function ensureListening(): Promise<void> {
  if (client) return
  connecting ??= connect().catch((err) => {
    console.error('[events] failed to start listener:', err.message)
    connecting = null
    setTimeout(() => void ensureListening(), 2000)
  })
  await connecting
}

export function subscribe(jobId: string, fn: Listener): () => void {
  let set = listeners.get(jobId)
  if (!set) {
    set = new Set()
    listeners.set(jobId, set)
  }
  set.add(fn)

  return () => {
    const s = listeners.get(jobId)
    if (!s) return
    s.delete(fn)
    // Drop the key too, or a long-running server accumulates one empty Set per
    // job it ever streamed.
    if (s.size === 0) listeners.delete(jobId)
  }
}
