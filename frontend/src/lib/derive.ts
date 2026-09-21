import { EXPORT_SIZES } from '../data/fixtures'
import type { Clip, JobStatus, QuotaDTO, Ratio, Screen } from '../types'

/**
 * The daily allowance, from the server's count.
 *
 * This used to take a local `videosUsed` counter that the app incremented itself.
 * That counter started at zero on every reload, was never persisted and knew
 * nothing about jobs created on another device -- so after generating one video
 * the sidebar still said "3 of 3 free videos left". The allowance is a rolling
 * 24-hour window enforced on the server (quota.ts), and only the server can
 * count it.
 *
 * `known: false` while the fetch is in flight, so the UI can stay quiet rather
 * than show a number that is probably wrong.
 */
export function quota(q: QuotaDTO | null) {
  if (!q) {
    return { known: false, label: '', usedLabel: '', width: '0%', resetLabel: '', exhausted: false }
  }

  const remaining = Math.max(0, q.remaining)
  const spent = Math.min(q.used, q.limit)

  return {
    known: true,
    label: remaining === 0 ? 'No videos left today' : `${remaining} of ${q.limit} videos left today`,
    usedLabel: `${q.used} of ${q.limit}`,
    // Clamped: a limit lowered after jobs were created would otherwise push the
    // meter past its track.
    width: `${q.limit === 0 ? 100 : Math.round((spent / q.limit) * 100)}%`,
    resetLabel: resetLabel(q.resetsAt),
    exhausted: remaining === 0,
  }
}

/**
 * When the next slot frees up, in relative terms.
 *
 * Deliberately not a date: the window rolls continuously, so "resets on the 1st"
 * (which this app used to claim) is simply untrue.
 */
function resetLabel(resetsAt: string | null): string {
  if (!resetsAt) return ''

  const ms = Date.parse(resetsAt) - Date.now()
  if (Number.isNaN(ms)) return ''
  // Already elapsed, or clock skew between server and browser.
  if (ms <= 0) return 'A slot frees up any moment'

  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `A slot frees up in ${minutes} min`
  return `A slot frees up in ${Math.round(minutes / 60)}h`
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
