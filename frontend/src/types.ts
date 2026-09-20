export type Screen =
  /**
   * Before /api/auth/me has answered. Renders nothing: without it every reload
   * flashes the login screen for a moment before landing on your projects.
   */
  | 'booting'
  | 'login'
  | 'new'
  | 'setup'
  | 'processing'
  | 'results'
  | 'projects'
  | 'plan'
  | 'settings'
  | 'editor'

/** The app screens that sit inside the signed-in shell with the sidebar. */
export const APP_SCREENS = [
  'new',
  'setup',
  'processing',
  'results',
  'projects',
  'plan',
  'settings',
] as const satisfies readonly Screen[]

export type Ratio = '9:16' | '1:1' | '4:5'

/** Which sample link the "try one of these" buttons load. */
export type SourceKey = 'stream' | 'podcast'

export type JobStatus =
  | 'pending'
  | 'downloading'
  | 'transcribing'
  | 'analyzing'
  | 'rendering'
  | 'completed'
  | 'failed'
  | 'cancelled'

/**
 * A resolved source video.
 *
 * `length` and `eta` stay display strings so the source card renders unchanged,
 * but `durationSeconds` is now carried alongside them -- the prototype had only
 * the formatted string, which nothing downstream could compute with.
 */
export interface Source {
  /** Server id, needed to start a job against this source. */
  videoId: string
  platform: string
  title: string
  length: string
  durationSeconds: number
  meta: string
  eta: string
  thumbnailUrl: string | null
}

/** One rendered output file for a clip, in one aspect ratio. */
export interface Render {
  ratio: Ratio
  /** Signed, expiring URL. Null until the render is ready. */
  url: string | null
  thumbUrl: string | null
  width: number | null
  height: number | null
  sizeBytes: number | null
  status: 'pending' | 'rendering' | 'ready' | 'failed'
}

export interface Clip {
  /** Server uuid. The prototype used an array index, which no longer survives a re-cut. */
  id: string
  /** Ordinal within the job, for display order and file naming. */
  idx: number
  /** Headline shown on the card. */
  t: string
  /** In / out point in the source, in seconds. */
  s: number
  e: number
  /** Hook score, 0-100. */
  sc: number
  /** Transcript snippet around the moment. */
  sn: string
  /** Suggested caption for posting. */
  cap: string
  /** The burned-in subtitle line, pre-wrapped. */
  line: string
  status: 'pending' | 'rendering' | 'ready' | 'failed'
  /** One entry per requested aspect ratio. */
  renders: Partial<Record<Ratio, Render>>
  /** Local-only: whether the card is ticked for download. */
  selected: boolean
}

/** A finished job, kept so its clips can be reopened later. */
export interface Project {
  id: string
  title: string
  /** Carried inline: a real project cannot be a key into a fixtures object. */
  source: Source
  clipCount: number
  /** Epoch ms when the job finished. */
  createdAt: number
}
