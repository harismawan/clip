import { test, expect, describe } from 'bun:test'
import { validateRanges, textInRange, type Candidate } from './clipRanges.ts'
import type { TranscriptSegment } from './schema.ts'

/** 200 segments of 5s each = a 1000s source with clean 5s boundaries. */
const segments: TranscriptSegment[] = Array.from({ length: 200 }, (_, i) => ({
  start: i * 5,
  end: i * 5 + 5,
  text: `segment ${i}`,
}))

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  title: 'A moment',
  start: 100,
  end: 145,
  score: 80,
  snippet: 'snippet',
  caption: 'caption',
  line: 'line',
  ...over,
})

const base = { durationSeconds: 1000, lengthIdx: 1, count: 10, segments }

describe('validateRanges', () => {
  test('keeps a well-formed range', () => {
    const out = validateRanges([candidate()], base)
    expect(out).toHaveLength(1)
    expect(out[0].start).toBe(100)
    expect(out[0].end).toBe(145)
  })

  // The whole point of this module: a model that hallucinates a range past the
  // end of the video must never reach ffmpeg.
  test('never emits a range past the source duration', () => {
    const out = validateRanges([candidate({ start: 980, end: 1200 })], base)
    for (const c of out) {
      expect(c.end).toBeLessThanOrEqual(1000)
      expect(c.start).toBeGreaterThanOrEqual(0)
    }
  })

  test('drops a range that starts after the video ends', () => {
    expect(validateRanges([candidate({ start: 5000, end: 5060 })], base)).toHaveLength(0)
  })

  test('drops an inverted range', () => {
    expect(validateRanges([candidate({ start: 300, end: 200 })], base)).toHaveLength(0)
  })

  test('drops non-finite values rather than passing NaN to ffmpeg', () => {
    const bad = [
      candidate({ start: NaN, end: 100 }),
      candidate({ start: 0, end: Infinity }),
    ]
    expect(validateRanges(bad, base)).toHaveLength(0)
  })

  test('enforces the length window: a too-long range is trimmed', () => {
    const out = validateRanges([candidate({ start: 100, end: 500 })], base)
    expect(out).toHaveLength(1)
    expect(out[0].end - out[0].start).toBeLessThanOrEqual(60)
  })

  test('enforces the length window: a too-short range is grown', () => {
    const out = validateRanges([candidate({ start: 100, end: 105 })], base)
    expect(out).toHaveLength(1)
    expect(out[0].end - out[0].start).toBeGreaterThanOrEqual(30)
  })

  test('respects each length preset', () => {
    for (const [idx, min, max] of [
      [0, 12, 30],
      [1, 30, 60],
      [2, 60, 90],
    ] as const) {
      const out = validateRanges([candidate({ start: 100, end: 400 })], { ...base, lengthIdx: idx })
      expect(out).toHaveLength(1)
      const dur = out[0].end - out[0].start
      expect(dur).toBeGreaterThanOrEqual(min)
      expect(dur).toBeLessThanOrEqual(max)
    }
  })

  test('drops overlapping ranges, keeping the higher score', () => {
    const out = validateRanges(
      [
        candidate({ start: 100, end: 145, score: 60, title: 'lower' }),
        candidate({ start: 120, end: 165, score: 90, title: 'higher' }),
      ],
      base,
    )
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('higher')
  })

  test('keeps adjacent but non-overlapping ranges', () => {
    const out = validateRanges(
      [
        candidate({ start: 100, end: 145, score: 90 }),
        candidate({ start: 145, end: 190, score: 80 }),
      ],
      base,
    )
    expect(out).toHaveLength(2)
  })

  test('snaps boundaries to segment edges so clips do not open mid-word', () => {
    // 102 and 143 both land inside 5s segments.
    const out = validateRanges([candidate({ start: 102, end: 143 })], base)
    expect(out).toHaveLength(1)
    expect(out[0].start % 5).toBe(0)
    expect(out[0].end % 5).toBe(0)
  })

  test('returns at most `count` clips, best first', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      candidate({ start: i * 60, end: i * 60 + 45, score: i }),
    )
    const out = validateRanges(many, { ...base, count: 5 })
    expect(out).toHaveLength(5)
    expect(out[0].score).toBeGreaterThanOrEqual(out[4].score)
  })

  test('clamps a score outside 0-100', () => {
    const out = validateRanges(
      [candidate({ score: 900 }), candidate({ start: 300, end: 345, score: -20 })],
      base,
    )
    expect(out.every((c) => c.score >= 0 && c.score <= 100)).toBe(true)
  })

  test('substitutes a title when the model returns an empty one', () => {
    const out = validateRanges([candidate({ title: '   ' })], base)
    expect(out[0].title).toBe('Untitled moment')
  })

  test('a source shorter than the preset minimum yields nothing', () => {
    const shortSegments: TranscriptSegment[] = [{ start: 0, end: 8, text: 'hi' }]
    const out = validateRanges([candidate({ start: 0, end: 8 })], {
      durationSeconds: 8,
      lengthIdx: 1,
      count: 5,
      segments: shortSegments,
    })
    expect(out).toHaveLength(0)
  })

  test('works with no transcript segments at all', () => {
    const out = validateRanges([candidate()], { ...base, segments: [] })
    expect(out).toHaveLength(1)
    expect(out[0].end).toBeLessThanOrEqual(1000)
  })
})

describe('textInRange', () => {
  test('collects only segments overlapping the range', () => {
    const text = textInRange(segments, 10, 20)
    expect(text).toBe('segment 2 segment 3')
  })

  test('is empty outside the transcript', () => {
    expect(textInRange(segments, 5000, 5100)).toBe('')
  })
})
