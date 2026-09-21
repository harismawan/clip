/**
 * WebVTT subtitle parser for YouTube / Twitch auto-captions.
 * Turns VTT text with timestamps into TranscriptSegment[].
 */
import type { TranscriptSegment } from '../../shared/schema.ts'

function parseTimestamp(ts: string): number {
  const parts = ts.trim().split(':')
  if (parts.length === 3) {
    const [h, m, s] = parts
    return Number(h) * 3600 + Number(m) * 60 + Number(s)
  }
  if (parts.length === 2) {
    const [m, s] = parts
    return Number(m) * 60 + Number(s)
  }
  return 0
}

function cleanLine(line: string): string {
  return line
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseVttToSegments(vttContent: string): TranscriptSegment[] {
  const lines = vttContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const rawCues: { start: number; end: number; text: string }[] = []

  let currentStart: number | null = null
  let currentEnd: number | null = null
  let textLines: string[] = []

  const commitCue = () => {
    if (currentStart !== null && currentEnd !== null) {
      if (currentEnd - currentStart >= 0.05) {
        const cleaned = textLines.map(cleanLine).filter(Boolean)
        if (cleaned.length > 0) {
          const activeText = cleaned[cleaned.length - 1]
          rawCues.push({ start: currentStart, end: currentEnd, text: activeText })
        }
      }
    }
    currentStart = null
    currentEnd = null
    textLines = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.includes('-->')) {
      commitCue()
      const arrowIdx = line.indexOf('-->')
      const startPart = line.slice(0, arrowIdx).trim()
      const endPart = line.slice(arrowIdx + 3).trim().split(/\s+/)[0]
      currentStart = parseTimestamp(startPart)
      currentEnd = parseTimestamp(endPart)
      continue
    }

    if (currentStart !== null) {
      // We are inside a cue
      if (line.startsWith('NOTE') || line.startsWith('WEBVTT')) continue
      textLines.push(line)
    }
  }

  commitCue()

  // Deduplicate consecutive identical lines
  const segments: TranscriptSegment[] = []
  for (const cue of rawCues) {
    const last = segments[segments.length - 1]
    if (last && last.text === cue.text) {
      last.end = Math.max(last.end, cue.end)
    } else {
      segments.push({ ...cue })
    }
  }

  return segments
}
