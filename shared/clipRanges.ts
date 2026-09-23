/**
 * Validation of model-proposed clip ranges.
 *
 * An LLM will confidently return ranges that run past the end of the video,
 * overlap each other, or are three seconds long. Nothing here is allowed to
 * reach ffmpeg unvalidated -- a bad range is a wasted render at best and a
 * failed job at worst.
 *
 * Pure functions, no I/O: this is the part of the pipeline worth unit testing.
 */
import type { TranscriptSegment } from './schema.ts'
import { LENGTH_PRESETS } from './types.ts'

export interface Candidate {
  title: string
  start: number
  end: number
  score: number
  snippet: string
  caption: string
  line: string
}

export interface ValidateOptions {
  durationSeconds: number
  /** Index into LENGTH_PRESETS. */
  lengthIdx: number
  /** Maximum clips to return. */
  count: number
  segments: TranscriptSegment[]
}

/**
 * Clamp, snap to speech boundaries, enforce the length window, drop overlaps,
 * and take the best `count`.
 *
 * Returned ranges are guaranteed to satisfy:
 *   0 <= start < end <= duration, and (end - start) within the preset window.
 */
export function validateRanges(candidates: Candidate[], opts: ValidateOptions): Candidate[] {
  const preset = LENGTH_PRESETS[opts.lengthIdx] ?? LENGTH_PRESETS[1]
  const segments = [...opts.segments].sort((a, b) => a.start - b.start)

  const cleaned: Candidate[] = []

  for (const raw of candidates) {
    if (!Number.isFinite(raw.start) || !Number.isFinite(raw.end)) continue

    let start = Math.max(0, Math.min(raw.start, opts.durationSeconds))
    let end = Math.max(0, Math.min(raw.end, opts.durationSeconds))
    if (end <= start) continue

    // Snap to speech boundaries so clips do not open or close mid-word.
    if (segments.length > 0) {
      start = snapToSegmentStart(segments, start)
      end = snapToSegmentEnd(segments, end)
      if (end <= start) continue
    }

    const fitted = fitToWindow(start, end, preset, opts.durationSeconds, segments)
    if (!fitted) continue

    cleaned.push({
      ...raw,
      start: fitted.start,
      end: fitted.end,
      score: clampScore(raw.score),
      title: (raw.title ?? '').trim() || 'Untitled moment',
      snippet: (raw.snippet ?? '').trim(),
      caption: (raw.caption ?? '').trim(),
      line: (raw.line ?? '').trim(),
    })
  }

  return dropOverlaps(cleaned).slice(0, opts.count)
}

/**
 * Grow or shrink a range into the preset window.
 *
 * Growing prefers to extend the end (a hook plays better with its payoff than
 * with extra lead-in); only when the end is at the video's limit does it extend
 * backwards. Returns null when the window cannot be satisfied at all.
 */
function fitToWindow(
  start: number,
  end: number,
  preset: { min: number; max: number },
  duration: number,
  segments: TranscriptSegment[],
): { start: number; end: number } | null {
  let s = start
  let e = end

  if (e - s > preset.max) {
    e = s + preset.max
    // Re-snap so trimming does not land mid-word.
    if (segments.length > 0) {
      const snapped = snapToSegmentEnd(segments, e)
      if (snapped > s && snapped - s <= preset.max) e = snapped
    }
  }

  if (e - s < preset.min) {
    const wanted = preset.min - (e - s)
    const roomAfter = duration - e
    const grow = Math.min(wanted, roomAfter)
    e += grow

    if (e - s < preset.min) {
      // Still short: take what remains from the front.
      s = Math.max(0, s - (preset.min - (e - s)))
    }
  }

  // The source itself may be shorter than the window; reject rather than
  // emitting a range that ffmpeg would silently truncate.
  if (e - s < preset.min) return null
  if (e > duration || s < 0 || e <= s) return null

  return { start: round3(s), end: round3(e) }
}

/**
 * Greedy highest-score-first selection, skipping anything that overlaps an
 * already-accepted range. Two clips covering the same moment are the same clip.
 */
function dropOverlaps(candidates: Candidate[]): Candidate[] {
  const kept: Candidate[] = []

  for (const c of [...candidates].sort((a, b) => b.score - a.score)) {
    const clashes = kept.some((k) => overlaps(c, k))
    if (!clashes) kept.push(c)
  }

  return kept.sort((a, b) => b.score - a.score)
}

/** A stretch of source. Candidate satisfies this; so does a clip row. */
export interface Range {
  start: number
  end: number
}

/** Any shared time at all counts as an overlap. */
export function overlaps(a: Range, b: Range): boolean {
  return a.start < b.end && b.start < a.end
}

/**
 * Whether a range collides with any of a set.
 *
 * dropOverlaps only dedupes candidates against each other -- it cannot see
 * ranges that are not in the list it was handed. Recommendations need exactly
 * that: a suggestion must also avoid the clips the user already has, which by
 * definition are not candidates.
 */
export function overlapsAny(r: Range, others: Range[]): boolean {
  return others.some((o) => overlaps(r, o))
}

function snapToSegmentStart(segments: TranscriptSegment[], t: number): number {
  // The segment being spoken at t: start there rather than mid-sentence.
  const containing = segments.find((s) => t >= s.start && t < s.end)
  if (containing) return containing.start

  let best = segments[0].start
  let bestDist = Math.abs(best - t)
  for (const s of segments) {
    const d = Math.abs(s.start - t)
    if (d < bestDist) {
      best = s.start
      bestDist = d
    }
  }
  return best
}

function snapToSegmentEnd(segments: TranscriptSegment[], t: number): number {
  const containing = segments.find((s) => t > s.start && t <= s.end)
  if (containing) return containing.end

  let best = segments[segments.length - 1].end
  let bestDist = Math.abs(best - t)
  for (const s of segments) {
    const d = Math.abs(s.end - t)
    if (d < bestDist) {
      best = s.end
      bestDist = d
    }
  }
  return best
}

function clampScore(n: unknown): number {
  const v = Math.round(Number(n))
  if (!Number.isFinite(v)) return 50
  return Math.min(100, Math.max(0, v))
}

const round3 = (n: number) => Math.round(n * 1000) / 1000

/** Transcript text covering a range, for the card's snippet fallback. */
export function textInRange(segments: TranscriptSegment[], start: number, end: number): string {
  return segments
    .filter((s) => s.end > start && s.start < end)
    .map((s) => s.text.trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}
