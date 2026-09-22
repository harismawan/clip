import { describe, expect, test } from 'bun:test'
import { nextIdxFor, trimError } from './routes/clips.ts'
import { EDITOR_SPAN, MIN_CLIP_SECONDS } from '../../shared/types.ts'

/**
 * These bounds are the only guard between the editor and ffmpeg: validateRanges
 * runs inside processJob and never sees a hand-edited range.
 */
describe('trimError', () => {
  const DURATION = 7200

  test('accepts an ordinary trim', () => {
    expect(trimError(842, 884, DURATION)).toBeNull()
  })

  test('rejects an out point at or before the in point', () => {
    expect(trimError(100, 100, DURATION)).not.toBeNull()
    expect(trimError(100, 99, DURATION)).not.toBeNull()
  })

  test('rejects a clip shorter than the minimum', () => {
    expect(trimError(100, 100 + MIN_CLIP_SECONDS - 0.1, DURATION)).not.toBeNull()
    expect(trimError(100, 100 + MIN_CLIP_SECONDS, DURATION)).toBeNull()
  })

  test('rejects a clip longer than the editor window', () => {
    // The timeline cannot show more than this, so a longer range could only
    // arrive from a crafted request.
    expect(trimError(0, EDITOR_SPAN + 1, DURATION)).not.toBeNull()
    expect(trimError(0, EDITOR_SPAN, DURATION)).toBeNull()
  })

  test('rejects a range running past the end of the video', () => {
    expect(trimError(DURATION - 10, DURATION + 5, DURATION)).not.toBeNull()
    expect(trimError(DURATION - 10, DURATION, DURATION)).toBeNull()
  })
})

describe('nextIdxFor', () => {
  test('appends after the highest idx in the project', () => {
    expect(nextIdxFor([{ idx: 0 }, { idx: 1 }, { idx: 2 }])).toBe(3)
  })

  test('takes the max, not the count, so a deleted clip cannot cause a collision', () => {
    // idx drives the file name inside a download zip as well as display order,
    // so two clips sharing one is a silently overwritten file.
    expect(nextIdxFor([{ idx: 0 }, { idx: 5 }])).toBe(6)
  })

  test('is unfazed by unsorted rows', () => {
    expect(nextIdxFor([{ idx: 7 }, { idx: 2 }, { idx: 4 }])).toBe(8)
  })

  test('starts at zero for a project with no clips', () => {
    expect(nextIdxFor([])).toBe(0)
  })
})
