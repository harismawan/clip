/**
 * Pure parsing and prompt-shaping helpers.
 *
 * Deliberately free of env and I/O imports: the stage modules validate
 * configuration at import time (and exit when it is missing), which would
 * otherwise make these untestable without a full environment.
 */
import type { TranscriptSegment } from '../../shared/schema.ts'

/**
 * Compact the transcript for the analysis prompt.
 *
 * Segments are merged up to ~12 seconds so a two-hour video becomes a few
 * thousand lines instead of tens of thousands. Coarser timestamps are fine
 * because ranges.ts snaps boundaries back to real segment edges afterwards.
 */
export function renderTranscript(segments: TranscriptSegment[], bucketSeconds = 12): string {
  const lines: string[] = []
  let start: number | null = null
  let buffer: string[] = []

  const flush = () => {
    if (start === null || buffer.length === 0) return
    lines.push(`[${start.toFixed(1)}] ${buffer.join(' ').replace(/\s+/g, ' ').trim()}`)
    buffer = []
    start = null
  }

  for (const s of segments) {
    if (start === null) start = s.start
    buffer.push(s.text.trim())
    if (s.end - start >= bucketSeconds) flush()
  }
  flush()

  return lines.join('\n')
}

/** Models sometimes wrap JSON in a markdown fence despite a strict schema. */
export function extractJson(text: string): string {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) return trimmed

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) return fenced[1].trim()

  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first !== -1 && last > first) return trimmed.slice(first, last + 1)

  return trimmed
}

/**
 * whisper-ctranslate2 prints each segment as "[00:12.340 --> 00:15.220] text".
 * The end timestamp is how far through the audio it has got.
 */
export function parseWhisperProgress(line: string): number | null {
  const m = line.match(/-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d+)/)
  if (!m) return null
  const h = m[1] ? +m[1] : 0
  return h * 3600 + +m[2] * 60 + +m[3] + Number(`0.${m[4]}`)
}
