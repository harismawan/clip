import { test, expect, describe } from 'bun:test'
import { extractJson, renderTranscript, parseWhisperProgress } from '../parse.ts'
import type { TranscriptSegment } from '../../../shared/schema.ts'

describe('extractJson', () => {
  test('passes through bare JSON', () => {
    expect(extractJson('{"clips":[]}')).toBe('{"clips":[]}')
  })

  // Models do this even when handed a strict schema.
  test('unwraps a markdown fence', () => {
    expect(extractJson('```json\n{"clips":[]}\n```')).toBe('{"clips":[]}')
    expect(extractJson('```\n{"clips":[]}\n```')).toBe('{"clips":[]}')
  })

  test('recovers JSON wrapped in prose', () => {
    expect(extractJson('Here you go:\n{"clips":[]}\nHope that helps!')).toBe('{"clips":[]}')
  })

  test('leaves unparseable input alone for the caller to reject', () => {
    expect(extractJson('no json here')).toBe('no json here')
  })
})

describe('renderTranscript', () => {
  const segments: TranscriptSegment[] = Array.from({ length: 20 }, (_, i) => ({
    start: i * 5,
    end: i * 5 + 5,
    text: `line ${i}`,
  }))

  test('prefixes each bucket with its start time in seconds', () => {
    const out = renderTranscript(segments, 12)
    expect(out.split('\n')[0]).toMatch(/^\[0\.0\] /)
  })

  test('merges segments into buckets, shrinking the prompt', () => {
    const merged = renderTranscript(segments, 12).split('\n')
    expect(merged.length).toBeLessThan(segments.length)
  })

  test('loses no text while bucketing', () => {
    const out = renderTranscript(segments, 12)
    for (let i = 0; i < 20; i++) expect(out).toContain(`line ${i}`)
  })

  test('handles an empty transcript', () => {
    expect(renderTranscript([], 12)).toBe('')
  })
})

describe('parseWhisperProgress', () => {
  test('reads the end timestamp of a segment line', () => {
    expect(parseWhisperProgress('[00:12.340 --> 00:15.220]  some text')).toBeCloseTo(15.22, 2)
  })

  test('handles hour-long sources', () => {
    expect(parseWhisperProgress('[01:00:00.000 --> 01:02:03.500] text')).toBeCloseTo(3723.5, 1)
  })

  test('returns null for unrelated output', () => {
    expect(parseWhisperProgress('Detected language: en')).toBeNull()
  })
})
