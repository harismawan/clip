/**
 * Placing the editor window by hand.
 *
 * The detail timeline is still 150 seconds -- four hours across 1000px is 13
 * seconds per pixel, which cannot place a 3-second cut. Manual mode moves that
 * window rather than replacing it, so these three functions are the whole of
 * it: where the window may sit, and which peaks belong to the two timelines.
 */
import { test, expect, describe } from 'bun:test'
import { manualWindow, overviewPeaks, windowPeaks } from './manual'

const SPAN = 150

describe('manualWindow', () => {
  test('sits where it is put, a full span wide', () => {
    expect(manualWindow(600, 3600)).toEqual({ start: 600, span: SPAN })
  })

  test('cannot start before the video does', () => {
    expect(manualWindow(-40, 3600)).toEqual({ start: 0, span: SPAN })
  })

  test('slides back rather than running past the end', () => {
    // Dropped 30s from the end of an hour: a full span still fits if it moves.
    expect(manualWindow(3570, 3600)).toEqual({ start: 3450, span: SPAN })
  })

  test('a video shorter than the span is shown whole', () => {
    // No sliding possible, so the window is the video.
    expect(manualWindow(10, 90)).toEqual({ start: 0, span: 90 })
  })

  test('is exact at the very end', () => {
    expect(manualWindow(3600, 3600)).toEqual({ start: 3450, span: SPAN })
  })
})

describe('overviewPeaks', () => {
  const ramp = Array.from({ length: 1000 }, (_, i) => i % 101)

  test('downsamples to the requested number of bars', () => {
    expect(overviewPeaks(ramp, 200)).toHaveLength(200)
  })

  test('keeps the loudest of each bucket, so a peak never disappears', () => {
    // Averaging would flatten a single loud moment into the silence around it,
    // which is exactly what the overview exists to show.
    const mostlySilent = [0, 0, 0, 100, 0, 0, 0, 0]
    expect(overviewPeaks(mostlySilent, 2)).toEqual([100, 0])
  })

  test('returns what it was given when there is nothing to downsample', () => {
    expect(overviewPeaks([1, 2, 3], 10)).toEqual([1, 2, 3])
  })

  test('an absent waveform is empty, not a crash', () => {
    expect(overviewPeaks(null, 100)).toEqual([])
    expect(overviewPeaks([], 100)).toEqual([])
  })
})

describe('windowPeaks', () => {
  // One value per second, so the index IS the second.
  const perSecond = Array.from({ length: 600 }, (_, i) => i)

  test('slices exactly the seconds the window covers', () => {
    const out = windowPeaks(perSecond, { start: 100, span: 10 })
    expect(out).toEqual([100, 101, 102, 103, 104, 105, 106, 107, 108, 109])
  })

  test('rounds a fractional start to a whole second', () => {
    expect(windowPeaks(perSecond, { start: 100.6, span: 2 })).toEqual([101, 102])
  })

  test('stops at the end of the data rather than padding with silence', () => {
    // A window that overhangs the end must not draw fake quiet bars.
    expect(windowPeaks(perSecond, { start: 598, span: 10 })).toEqual([598, 599])
  })

  test('an absent waveform is empty, not a crash', () => {
    expect(windowPeaks(null, { start: 0, span: 150 })).toEqual([])
  })
})
