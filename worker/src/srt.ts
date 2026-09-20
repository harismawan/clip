/**
 * Subtitle generation. Net-new for this project -- clipper produces sidecar SRT
 * files but never burns them in.
 *
 * Pure functions, no I/O.
 */
import type { TranscriptSegment } from '../../shared/schema.ts'

/** Seconds -> "00:01:23,456". SRT uses a comma before milliseconds, not a dot. */
export function srtTime(seconds: number): string {
  const clamped = Math.max(0, seconds)
  const ms = Math.round(clamped * 1000)
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const milli = ms % 1000
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(h)}:${p(m)}:${p(s)},${p(milli, 3)}`
}

export interface SrtOptions {
  /** Wrap to at most this many characters per line. */
  maxCharsPerLine?: number
  /** At most this many lines per cue; extra text is dropped, not overflowed. */
  maxLines?: number
}

/**
 * Build an SRT covering [start, end), with timestamps rebased so the clip
 * begins at zero.
 *
 * Segments straddling a boundary are kept and truncated, because dropping them
 * would silently lose the first or last words of the clip -- usually the hook.
 */
export function buildClipSrt(
  segments: TranscriptSegment[],
  start: number,
  end: number,
  opts: SrtOptions = {},
): string {
  const maxChars = opts.maxCharsPerLine ?? 32
  const maxLines = opts.maxLines ?? 2
  const duration = end - start

  const cues = segments
    .filter((s) => s.end > start && s.start < end)
    .map((s) => ({
      start: Math.max(0, s.start - start),
      end: Math.min(duration, s.end - start),
      text: s.text.trim(),
    }))
    .filter((c) => c.text.length > 0 && c.end > c.start)
    .sort((a, b) => a.start - b.start)

  return cues
    .map((c, i) => {
      const text = wrapLines(c.text, maxChars, maxLines).join('\n')
      return `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${text}\n`
    })
    .join('\n')
}

/**
 * Greedy word wrap. A word longer than the limit gets its own line rather than
 * being hyphenated -- breaking a URL or a long name mid-token reads worse than
 * one overlong line.
 */
export function wrapLines(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''

  for (const word of words) {
    if (current.length === 0) {
      current = word
    } else if (current.length + 1 + word.length <= maxChars) {
      current += ` ${word}`
    } else {
      lines.push(current)
      current = word
      if (lines.length === maxLines) break
    }
  }

  if (current && lines.length < maxLines) lines.push(current)
  return lines.length > 0 ? lines.slice(0, maxLines) : ['']
}

/**
 * The pre-wrapped two-line hook shown on a result card (`ClipDTO.line`).
 * Distinct from the burned subtitle track: it is one punchy phrase, not the
 * whole clip's speech.
 */
export function wrapHookLine(text: string, maxChars = 24): string {
  return wrapLines(text.replace(/\s+/g, ' ').trim(), maxChars, 2).join('\n')
}
