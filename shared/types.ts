/**
 * The wire contract between backend, worker and frontend.
 *
 * Clip field names stay terse (`t`, `s`, `e`, `sc`, `sn`, `cap`, `line`) to match
 * the prototype's existing components -- renaming them would touch every screen
 * for no behavioural gain. The database uses full names; the backend maps.
 */

export type Ratio = '9:16' | '1:1' | '4:5'

export const RATIOS: readonly Ratio[] = ['9:16', '1:1', '4:5'] as const

/** Output pixel dimensions per ratio. Mirrors the frontend's EXPORT_SIZES. */
export const RATIO_DIMS: Record<Ratio, { w: number; h: number }> = {
  '9:16': { w: 1080, h: 1920 },
  '1:1': { w: 1080, h: 1080 },
  '4:5': { w: 1080, h: 1350 },
}

/**
 * Clip length windows, indexed by the setup screen's `lengthIdx`.
 * Mirrors the frontend's LENGTHS = ['<30s', '30-60s', '60-90s'].
 */
export const LENGTH_PRESETS: readonly { min: number; max: number }[] = [
  { min: 12, max: 30 },
  { min: 30, max: 60 },
  { min: 60, max: 90 },
] as const

export type JobStatus =
  | 'pending'
  | 'downloading'
  | 'transcribing'
  | 'analyzing'
  | 'rendering'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** Terminal states -- the SSE stream closes once a job reaches one of these. */
export const TERMINAL_STATUSES: readonly JobStatus[] = ['completed', 'failed', 'cancelled'] as const

export function isTerminal(s: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(s)
}

/**
 * Stage progress weights. Chosen to match ProcessingScreen.tsx, whose four
 * steps each own 24% of the bar.
 */
export const STAGE_WEIGHTS: readonly { status: JobStatus; from: number; to: number }[] = [
  { status: 'downloading', from: 0, to: 24 },
  { status: 'transcribing', from: 24, to: 48 },
  { status: 'analyzing', from: 48, to: 60 },
  { status: 'rendering', from: 60, to: 96 },
] as const

/**
 * Map a 0..1 fraction within a stage onto the overall 0..100 bar.
 * Out-of-range fractions clamp rather than overshoot into the next stage.
 */
export function stageProgress(status: JobStatus, fraction: number): number {
  const w = STAGE_WEIGHTS.find((s) => s.status === status)
  if (!w) return 0
  const f = Math.min(1, Math.max(0, fraction))
  return Math.round(w.from + (w.to - w.from) * f)
}

/** Source metadata shown on the setup screen. */
export interface SourceDTO {
  videoId: string
  platform: string
  title: string
  /** Display string, e.g. "1:58:24". */
  length: string
  durationSeconds: number
  /** e.g. "channelname · posted last week · 1080p available". */
  meta: string
  /** Display string, e.g. "~6 min". */
  eta: string
  thumbnailUrl: string | null
  /**
   * Full-length editor assets, present only once manual mode has built them.
   *
   * Null covers both "never built" and "evicted by retention" -- the editor
   * treats them identically, because the answer to both is to ask for a build.
   */
  proxyUrl?: string | null
  stripUrl?: string | null
  /** RMS 0-100, one per second of source. See videos.peaks. */
  peaks?: number[] | null
}

export interface RenderDTO {
  ratio: Ratio
  /** Presigned GET URL for the rendered MP4. Null until the render is ready. */
  url: string | null
  thumbUrl: string | null
  width: number | null
  height: number | null
  sizeBytes: number | null
  status: 'pending' | 'rendering' | 'ready' | 'failed'
}

export interface ClipDTO {
  /** UUID. The prototype used an array index; real clips need stable ids. */
  id: string
  idx: number
  /** Headline. */
  t: string
  /** In / out point in the source, seconds. */
  s: number
  e: number
  /** Hook score 0-100. */
  sc: number
  /** Transcript snippet around the moment. */
  sn: string
  /** Suggested caption for posting. */
  cap: string
  /** Pre-wrapped two-line hook shown on the card. Distinct from the burned subs. */
  line: string
  status: 'pending' | 'rendering' | 'ready' | 'failed'
  renders: Partial<Record<Ratio, RenderDTO>>

  /**
   * Editor assets. All null for clips made before they existed, which is what
   * lets the editor fall back to a placeholder instead of breaking.
   */
  proxyUrl: string | null
  stripUrl: string | null
  /** RMS levels 0-100 across the window, one per waveform bar. */
  peaks: number[] | null
  /** The stretch of source the proxy covers. Authoritative: do not recompute. */
  win: { start: number; span: number } | null
}

/** One transcript line, as GET /api/clips/:id/transcript returns it. */
export interface ClipTranscriptDTO {
  segments: { start: number; end: number; text: string }[]
}

/**
 * The stretch of source the editor timeline shows, in seconds.
 *
 * The worker encodes the proxy to these, and the trim a user can save is bounded
 * by them. `frontend/src/data/fixtures.ts` mirrors them as TIMELINE_LEAD_IN and
 * TIMELINE_SPAN -- the frontend declares its own view of wire constants rather
 * than importing across the workspace, so keep the two in step.
 */
export const EDITOR_LEAD_IN = 30
export const EDITOR_SPAN = 150

/** Shortest trim worth rendering. Below this the cut has no room for a hook. */
export const MIN_CLIP_SECONDS = 3

export interface JobDTO {
  id: string
  status: JobStatus
  stage: string | null
  progress: number
  error: string | null
  clipCount: number
  lengthIdx: number
  formats: Record<Ratio, boolean>
  subs: boolean
  source: SourceDTO
  clips: ClipDTO[]
  createdAt: string
  completedAt: string | null
}

/** A finished job as shown on the projects screen. */
export interface ProjectDTO {
  id: string
  title: string
  source: SourceDTO
  clipCount: number
  /** Epoch ms, matching the prototype's Project.createdAt. */
  createdAt: number
}

/**
 * The daily job allowance, as the server counts it.
 *
 * The client cannot compute this: it is a ROLLING 24-hour window over the user's
 * jobs, enforced in quota.ts, and it survives reloads, other devices and
 * cleared site data. A local counter was previously used and always drifted.
 */
export interface QuotaDTO {
  /** Jobs created in the last 24 hours. */
  used: number
  /** QUOTA_JOBS_PER_DAY on the server. */
  limit: number
  remaining: number
  /** Rendered bytes held, and the cap. Deleting a project lowers the first. */
  storageBytes: number
  storageLimitBytes: number
  /**
   * When the oldest job leaves the window and a slot frees up, ISO. Null when
   * nothing has been used, because there is nothing to wait for.
   */
  resetsAt: string | null
}

/** SSE payload on `GET /api/jobs/:id/events`. */
export interface ProgressEvent {
  jobId: string
  status: JobStatus
  stage: string | null
  progress: number
  error: string | null
}

export interface CreateJobBody {
  videoId: string
  count: number
  lengthIdx: number
  formats: Record<Ratio, boolean>
  subs: boolean
}

export interface AnalyzeBody {
  url: string
}
