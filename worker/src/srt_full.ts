/**
 * Build a full SRT file string from transcript segments.
 */
import type { TranscriptSegment } from '../../shared/schema.ts'
import { srtTime } from './srt.ts'

export function segmentsToFullSrt(segments: TranscriptSegment[]): string {
  return segments
    .filter((s) => s.text.trim().length > 0 && s.end > s.start)
    .map((s, i) => {
      return `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text.trim()}\n`
    })
    .join('\n')
}
