import { EXPORT_SIZES, FREE_VIDEO_ALLOWANCE } from '../data/fixtures'
import type { Clip, JobStatus, Ratio, Screen } from '../types'

export function quota(videosUsed: number) {
  return {
    label: `${FREE_VIDEO_ALLOWANCE - videosUsed} of ${FREE_VIDEO_ALLOWANCE} free videos left`,
    usedLabel: `${videosUsed} of ${FREE_VIDEO_ALLOWANCE}`,
    width: `${Math.round((videosUsed / FREE_VIDEO_ALLOWANCE) * 100)}%`,
  }
}

export function formatsLabel(formats: Record<Ratio, boolean>): string {
  const on = (Object.keys(formats) as Ratio[]).filter((k) => formats[k])
  return on.join(' and ') || 'none selected'
}

export function exportLabel(filter: Ratio, subs: boolean): string {
  return EXPORT_SIZES[filter] + (subs ? ' · subtitles burned in' : '')
}

/** The CSS aspect ratio for cards under the current format tab. */
export function clipAspect(filter: Ratio): string {
  return filter === '1:1' ? '1/1' : filter === '4:5' ? '4/5' : '9/16'
}

export function sortClips(clips: Clip[], byScore: boolean): Clip[] {
  return byScore ? [...clips].sort((a, b) => b.sc - a.sc) : [...clips].sort((a, b) => a.s - b.s)
}

export function selectedCount(clips: Clip[]): number {
  return clips.filter((c) => c.selected).length
}

/**
 * A re-cut used to shadow the headline with a `title` field. The server now
 * returns the current headline in `t`, so there is nothing left to resolve --
 * kept as a function so call sites need not change.
 */
export function clipTitle(clip: Clip): string {
  return clip.t
}

/** What the progress indicator should say, or that it should stay hidden. */
export interface JobIndicator {
  visible: boolean
  tone: 'active' | 'done' | 'failed'
  label: string
  /** 0-100, safe to feed straight to a width. */
  percent: number
  /** Where a click should land. */
  target: Screen
}

/**
 * The single decision behind the sidebar entry AND the banner.
 *
 * Both surfaces render from this, so they cannot disagree about whether a job is
 * running or what it is called. Takes only the four fields it needs rather than
 * the whole state, which keeps it trivially testable.
 *
 * A finished job does not disappear: it flips to "Clips ready" so the work is
 * still one click away from wherever you happen to be. A failed job stays too --
 * silently vanishing is how you would lose a 40-minute failure without noticing.
 * A cancelled job is the one case worth hiding, because you asked for that.
 */
export function jobIndicator(job: {
  jobId: string
  jobStatus: JobStatus | null
  stage: string | null
  progress: number
}): JobIndicator {
  const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)))
  const hidden: JobIndicator = {
    visible: false,
    tone: 'active',
    label: '',
    percent: 0,
    target: 'processing',
  }

  if (!job.jobId || !job.jobStatus) return hidden

  switch (job.jobStatus) {
    case 'completed':
      // Pinned to 100: the last SSE frame is sometimes missed, and a "ready"
      // badge sitting at 97% looks broken.
      return { visible: true, tone: 'done', label: 'Clips ready', percent: 100, target: 'results' }

    case 'failed':
      return {
        visible: true,
        tone: 'failed',
        label: 'Job failed',
        percent: clamp(job.progress),
        // The processing screen is where the error text is shown.
        target: 'processing',
      }

    case 'cancelled':
      return hidden

    default:
      return {
        visible: true,
        tone: 'active',
        label: job.stage ?? 'Processing…',
        percent: clamp(job.progress),
        target: 'processing',
      }
  }
}
