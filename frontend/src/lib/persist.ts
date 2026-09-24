import type { Ratio, Screen } from '../types'

// Bumped from v1: the shape changed when jobs moved server-side, and a stale
// v1 blob would restore projects and clips that no longer mean anything.
const KEY = 'snipline.v2'

/**
 * The slice of app state worth surviving a reload.
 *
 * Only preferences and the current job id. Clips, progress and the project list
 * come from the server now -- persisting them locally would only let them drift
 * out of date.
 */
export interface Persisted {
  /** Which job the clip screens were last showing; re-fetched on load. */
  jobId: string
  count: number
  lengthIdx: number
  formats: Record<Ratio, boolean>
  subs: boolean
  emailMe: boolean
  screen: Screen
  /** Moments sidebar open or collapsed. Optional: older blobs predate it. */
  recsOpen?: boolean
}

/**
 * Read back the saved slice. Storage is user-editable and may be blocked
 * outright, so anything unusable is dropped rather than allowed to reach the
 * render and white-screen an app you could then only fix by clearing storage.
 */
export function loadPersisted(): Partial<Persisted> {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const saved: unknown = JSON.parse(raw)
    if (!saved || typeof saved !== 'object') return {}
    const slice = { ...saved } as Partial<Persisted>
    // A job in flight now survives a reload -- the worker kept running and the
    // app re-subscribes to its progress, so 'processing' is restorable.
    if (typeof slice.jobId !== 'string') delete slice.jobId
    if (typeof slice.recsOpen !== 'boolean') delete slice.recsOpen
    return slice
  } catch {
    return {}
  }
}

export function savePersisted(slice: Persisted): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(slice))
  } catch {
    // Private mode, quota, blocked storage — the app still works without it.
  }
}
