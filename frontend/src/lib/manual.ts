/**
 * Placing the editor window by hand.
 *
 * Manual mode does not replace the editor, it unpins it. The detail timeline
 * stays 150 seconds -- four hours across a 1000px track is 13 seconds per
 * pixel, which cannot place a 3-second cut -- and these functions decide where
 * that window may sit and which audio belongs to each of the two timelines.
 *
 * TIMELINE_SPAN mirrors EDITOR_SPAN in shared/types.ts. The frontend declares
 * its own view of wire constants rather than importing across the workspace.
 */
import { TIMELINE_SPAN } from '../data/fixtures'

export interface Window {
  start: number
  span: number
}

/**
 * The window that results from dropping the playhead at `startSeconds`.
 *
 * Slides rather than shrinks when it would overhang the end: a window clipped
 * short near the end of a video would quietly cap how long a clip could be,
 * which is a confusing way to hit a limit. A source shorter than the span is
 * shown whole, because there is nowhere to slide to.
 */
export function manualWindow(startSeconds: number, durationSeconds: number): Window {
  const duration = Math.max(0, durationSeconds)
  const span = Math.min(TIMELINE_SPAN, duration)
  const start = Math.max(0, Math.min(startSeconds, duration - span))
  return { start, span }
}

/**
 * Downsample the full waveform to the bars an overview track can draw.
 *
 * Takes the LOUDEST value in each bucket rather than the mean. Averaging a
 * four-hour podcast down to 1200 bars turns every isolated loud moment into the
 * silence around it -- and finding those moments is the entire reason the
 * overview shows a waveform at all.
 */
export function overviewPeaks(peaks: number[] | null | undefined, bars: number): number[] {
  if (!peaks?.length) return []
  if (peaks.length <= bars) return peaks

  const out: number[] = []
  for (let b = 0; b < bars; b++) {
    const from = Math.floor((b * peaks.length) / bars)
    const to = Math.max(from + 1, Math.floor(((b + 1) * peaks.length) / bars))
    let loudest = 0
    for (let i = from; i < to && i < peaks.length; i++) {
      if (peaks[i] > loudest) loudest = peaks[i]
    }
    out.push(loudest)
  }
  return out
}

/**
 * The slice of the full waveform a window covers.
 *
 * Depends on the one-bucket-per-second density the worker writes: the index IS
 * the second, which is what lets one stored array serve both timelines instead
 * of encoding a second waveform per window. See sourceBuckets in the worker.
 */
export function windowPeaks(peaks: number[] | null | undefined, win: Window): number[] {
  if (!peaks?.length) return []
  const from = Math.max(0, Math.round(win.start))
  // No padding past the end: drawn bars that stand for no audio read as silence
  // that is really absence.
  return peaks.slice(from, Math.min(peaks.length, from + Math.round(win.span)))
}
