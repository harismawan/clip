export type Screen =
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

export type SourceKey = 'stream' | 'podcast'

export interface Source {
  platform: string
  title: string
  length: string
  meta: string
  eta: string
}

/** A moment the model picked out of the source video. */
export interface ClipSeed {
  /** Headline shown on the card. */
  t: string
  /** In / out point in the source, in seconds. */
  s: number
  e: number
  /** Hook score, 0–100. */
  sc: number
  /** Transcript snippet around the moment. */
  sn: string
  /** Suggested caption for posting. */
  cap: string
  /** The burned-in subtitle line, pre-wrapped. */
  line: string
}

export interface Clip extends ClipSeed {
  id: number
  selected: boolean
  /** Set when a clip has been recut, replacing the original headline. */
  title?: string
}

/** A finished job, kept so its clips can be reopened later. */
export interface Project {
  id: string
  title: string
  source: SourceKey
  clips: Clip[]
  /** Epoch ms when the job finished. */
  createdAt: number
}
