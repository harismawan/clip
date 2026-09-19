import type { Project, Ratio, Screen } from '../types'

const KEY = 'snipline.v1'

/** The slice of app state worth surviving a reload. */
export interface Persisted {
  projects: Project[]
  /** Which project the clip screens were last showing. */
  jobId: string
  videosUsed: number
  count: number
  lengthIdx: number
  formats: Record<Ratio, boolean>
  subs: boolean
  emailMe: boolean
  screen: Screen
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
    if (!Array.isArray(slice.projects)) delete slice.projects
    // A half-finished job can't resume — its timer died with the last page.
    if (slice.screen === 'processing') slice.screen = 'new'
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
