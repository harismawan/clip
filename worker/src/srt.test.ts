import { test, expect, describe } from 'bun:test'
import { srtTime, buildClipSrt, wrapLines, wrapHookLine, subtitleStyle } from './srt.ts'
import type { TranscriptSegment } from '../../shared/schema.ts'

const segments: TranscriptSegment[] = [
  { start: 0, end: 5, text: 'before the clip' },
  { start: 100, end: 103, text: 'first line of the clip' },
  { start: 103, end: 107, text: 'second line of the clip' },
  { start: 107, end: 112, text: 'third line' },
  { start: 500, end: 505, text: 'long after' },
]

describe('srtTime', () => {
  test('formats with a comma before milliseconds', () => {
    expect(srtTime(83.456)).toBe('00:01:23,456')
  })

  test('handles hours', () => {
    expect(srtTime(3723.1)).toBe('01:02:03,100')
  })

  test('clamps negatives to zero', () => {
    expect(srtTime(-5)).toBe('00:00:00,000')
  })
})

describe('buildClipSrt', () => {
  test('rebases timestamps so the clip starts at zero', () => {
    const srt = buildClipSrt(segments, 100, 112)
    expect(srt).toContain('00:00:00,000 --> 00:00:03,000')
    expect(srt).not.toContain('00:01:40')
  })

  test('excludes segments outside the range', () => {
    const srt = buildClipSrt(segments, 100, 112)
    expect(srt).not.toContain('before the clip')
    expect(srt).not.toContain('long after')
  })

  // Dropping a straddling segment would silently lose the first words of the
  // clip -- usually the hook it was selected for.
  test('keeps a straddling segment and truncates it to the clip', () => {
    const srt = buildClipSrt(segments, 101, 106)
    expect(srt).toContain('first line')
    expect(srt).toContain('00:00:00,000 -->')
    // Nothing may extend past the clip length (5s here).
    expect(srt).not.toMatch(/--> 00:00:0[6-9]/)
  })

  test('numbers cues from 1 in order', () => {
    const srt = buildClipSrt(segments, 100, 112)
    const ids = srt.split('\n\n').map((b) => b.trim().split('\n')[0])
    expect(ids).toEqual(['1', '2', '3'])
  })

  test('returns empty string when nothing falls in range', () => {
    expect(buildClipSrt(segments, 300, 360).trim()).toBe('')
  })
})

describe('wrapLines', () => {
  test('wraps at the character limit', () => {
    expect(wrapLines('one two three four five', 10, 2)).toEqual(['one two', 'three four'])
  })

  test('never exceeds maxLines', () => {
    expect(wrapLines('a b c d e f g h i j k', 3, 2)).toHaveLength(2)
  })

  test('gives an overlong word its own line rather than hyphenating', () => {
    const out = wrapLines('hi supercalifragilistic', 8, 2)
    expect(out[1]).toBe('supercalifragilistic')
  })

  test('handles empty input', () => {
    expect(wrapLines('', 10, 2)).toEqual([''])
  })
})

describe('wrapHookLine', () => {
  test('produces at most two lines separated by a newline', () => {
    const line = wrapHookLine('charge for the outcome, not the hours')
    expect(line.split('\n').length).toBeLessThanOrEqual(2)
  })

  test('collapses runs of whitespace', () => {
    expect(wrapHookLine('a    b')).toBe('a b')
  })
})

describe('subtitleStyle', () => {
  test('scales with output height so text is legible at any ratio', () => {
    const tall = subtitleStyle(1920)
    const square = subtitleStyle(1080)
    const size = (s: string) => Number(s.match(/FontSize=(\d+)/)![1])
    expect(size(tall)).toBeGreaterThan(size(square))
  })

  test('has an outline, since white text on bright video is unreadable', () => {
    expect(subtitleStyle(1920)).toMatch(/Outline=[1-9]/)
  })
})
