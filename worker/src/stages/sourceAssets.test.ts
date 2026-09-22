/**
 * The one-bucket-per-second contract.
 *
 * The frontend's detail band slices `peaks[start .. start+150]` for whatever
 * window the user placed. That only lines up with the audio if the array really
 * is one value per second, so the derivation is pinned here rather than left to
 * be quietly changed.
 */
import { test, expect, describe } from 'bun:test'
import { sourceBuckets } from './sourceAssets.ts'

describe('sourceBuckets', () => {
  test('is one per second', () => {
    expect(sourceBuckets(150)).toBe(150)
    expect(sourceBuckets(3600)).toBe(3600)
  })

  test('rounds a fractional duration rather than truncating toward silence', () => {
    expect(sourceBuckets(42.4)).toBe(42)
    expect(sourceBuckets(42.6)).toBe(43)
  })

  test('never returns zero, which would make an empty waveform', () => {
    // peaksFromPcm returns [] for zero buckets, and a zero-length array read as
    // a waveform draws nothing at all.
    expect(sourceBuckets(0)).toBe(1)
    expect(sourceBuckets(0.2)).toBe(1)
  })
})
