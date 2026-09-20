/**
 * API client. The prototype made no network calls at all, so this is the whole
 * boundary between the app and the backend.
 */
import type { Clip, Project, Ratio, Source, JobStatus } from '../types'

const BASE: string = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '')
const TOKEN: string = import.meta.env.VITE_API_TOKEN ?? ''

/** Thrown for any non-2xx response, carrying the server's own message. */
export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}/api${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
        ...init.headers,
      },
    })
  } catch {
    // A network failure has no response body, so it needs its own message --
    // "Failed to fetch" tells a user nothing actionable.
    throw new ApiError(0, 'Could not reach the server. Is the API running?')
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(res.status, body?.error ?? `Request failed (${res.status})`)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export interface JobSnapshot {
  id: string
  status: JobStatus
  stage: string | null
  progress: number
  error: string | null
  clipCount: number
  lengthIdx: number
  formats: Record<Ratio, boolean>
  subs: boolean
  source: Source
  clips: Omit<Clip, 'selected'>[]
  createdAt: string
  completedAt: string | null
}

export interface ProgressEvent {
  jobId: string
  status: JobStatus
  stage: string | null
  progress: number
  error: string | null
}

export const api = {
  analyze: (url: string) => call<Source>('/sources/analyze', {
    method: 'POST',
    body: JSON.stringify({ url }),
  }),

  createJob: (body: {
    videoId: string
    count: number
    lengthIdx: number
    formats: Record<Ratio, boolean>
    subs: boolean
  }) => call<{ jobId: string }>('/jobs', { method: 'POST', body: JSON.stringify(body) }),

  getJob: (id: string) => call<JobSnapshot>(`/jobs/${id}`),

  cancelJob: (id: string) => call<{ ok: boolean }>(`/jobs/${id}/cancel`, { method: 'POST' }),

  regenerate: (id: string) =>
    call<{ jobId: string }>(`/jobs/${id}/regenerate`, { method: 'POST' }),

  projects: () => call<Project[]>('/projects'),

  redoClip: (clipId: string) => call<{ ok: boolean }>(`/clips/${clipId}/redo`, { method: 'POST' }),

  /**
   * Subscribe to job progress.
   *
   * EventSource cannot send an Authorization header, so the token rides in the
   * query string here. It stays inside this app's own origin and is the same
   * shared secret the browser already holds, so this exposes nothing new.
   */
  subscribe(
    jobId: string,
    onEvent: (e: ProgressEvent) => void,
    onError?: () => void,
  ): () => void {
    const qs = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ''
    const es = new EventSource(`${BASE}/api/jobs/${jobId}/events${qs}`)

    es.onmessage = (msg) => {
      if (!msg.data) return // keep-alive ping
      try {
        onEvent(JSON.parse(msg.data) as ProgressEvent)
      } catch {
        // A malformed frame must not tear down a working stream.
      }
    }
    es.onerror = () => {
      es.close()
      onError?.()
    }

    return () => es.close()
  },

  /**
   * Download one or more clips.
   *
   * A single clip goes straight to its signed media URL; several are zipped by
   * the server. The blob dance is needed because the zip is a POST, which a
   * plain link cannot express.
   */
  async download(clipIds: string[], ratio: Ratio, urlForSingle?: string | null): Promise<void> {
    if (clipIds.length === 1 && urlForSingle) {
      triggerDownload(`${urlForSingle}&download=1`)
      return
    }

    const res = await fetch(`${BASE}/api/downloads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      },
      body: JSON.stringify({ clipIds, ratio }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      throw new ApiError(res.status, body?.error ?? 'Download failed')
    }

    const blob = await res.blob()
    const objectUrl = URL.createObjectURL(blob)
    triggerDownload(objectUrl, `clips-${ratio.replace(':', 'x')}.zip`)
    // Revoke on the next tick: revoking immediately races the click handler.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000)
  },
}

function triggerDownload(url: string, filename?: string) {
  const a = document.createElement('a')
  a.href = url
  if (filename) a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}
