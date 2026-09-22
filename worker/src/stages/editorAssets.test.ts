import { describe, expect, test } from 'bun:test'
import { needingAssets, peaksFromPcm, windowFor, PEAK_BUCKETS } from './editorAssets.ts'
import { EDITOR_LEAD_IN, EDITOR_SPAN } from '../../../shared/types.ts'

/** Signed 16-bit little-endian mono, the format the peaks pass asks ffmpeg for. */
function pcm(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2)
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2))
  return buf
}

describe('windowFor', () => {
  test('centres the lead-in ahead of the clip when there is room', () => {
    const w = windowFor(842, 884, 7200)
    expect(w.start).toBe(842 - EDITOR_LEAD_IN)
    expect(w.span).toBe(EDITOR_SPAN)
  })

  test('clamps at the start of the video', () => {
    // A clip 10s in cannot have 30s of lead-in, and a negative -ss would make
    // ffmpeg seek to zero while the frontend still mapped the timeline to -20.
    const w = windowFor(10, 40, 7200)
    expect(w.start).toBe(0)
    expect(w.span).toBe(EDITOR_SPAN)
  })

  test('clamps at the end of the video', () => {
    const w = windowFor(7180, 7195, 7200)
    expect(w.start).toBe(7200 - EDITOR_SPAN)
    expect(w.start + w.span).toBe(7200)
  })

  test('shrinks the span for a video shorter than the window', () => {
    const w = windowFor(5, 20, 60)
    expect(w.start).toBe(0)
    expect(w.span).toBe(60)
  })

  test('never ends before the clip does', () => {
    // A clip longer than the window would otherwise open with its out point
    // outside the timeline that is supposed to bound it.
    const w = windowFor(100, 340, 7200)
    expect(w.start + w.span).toBeGreaterThanOrEqual(340)
  })
})

describe('peaksFromPcm', () => {
  test('returns nothing for an empty buffer', () => {
    expect(peaksFromPcm(Buffer.alloc(0))).toEqual([])
  })

  test('reports silence as a flat zero line', () => {
    const out = peaksFromPcm(pcm(new Array(1000).fill(0)), 10)
    expect(out).toHaveLength(10)
    expect(out.every((v) => v === 0)).toBe(true)
  })

  test('normalises the loudest bucket to 100', () => {
    const quiet = new Array(500).fill(1000)
    const loud = new Array(500).fill(20000)
    const out = peaksFromPcm(pcm([...quiet, ...loud]), 2)
    expect(out[1]).toBe(100)
    expect(out[0]).toBeGreaterThan(0)
    expect(out[0]).toBeLessThan(100)
  })

  test('stays within 0-100 and free of NaN when buckets outnumber samples', () => {
    // A very short window still has to fill the strip rather than emit holes.
    const out = peaksFromPcm(pcm([8000, -8000, 4000]), PEAK_BUCKETS)
    expect(out).toHaveLength(PEAK_BUCKETS)
    expect(out.every((v) => Number.isFinite(v) && v >= 0 && v <= 100)).toBe(true)
  })

  test('is insensitive to sign, since a waveform measures level not polarity', () => {
    const positive = peaksFromPcm(pcm(new Array(200).fill(9000)), 4)
    const negative = peaksFromPcm(pcm(new Array(200).fill(-9000)), 4)
    expect(positive).toEqual(negative)
  })
})

describe('needingAssets', () => {
  const clip = (id: string, proxyKey: string | null) => ({ id, proxyKey })

  test('picks only the clips with no proxy', () => {
    const rows = [clip('a', 'k1'), clip('b', null), clip('c', null), clip('d', 'k2')]
    expect(needingAssets(rows).map((c) => c.id)).toEqual(['b', 'c'])
  })

  test('is empty when every clip already has one', () => {
    // The route answers 204 on this, so no download is ever queued.
    expect(needingAssets([clip('a', 'k1'), clip('b', 'k2')])).toEqual([])
  })

  test('is empty for a job with no clips', () => {
    expect(needingAssets([])).toEqual([])
  })
})
