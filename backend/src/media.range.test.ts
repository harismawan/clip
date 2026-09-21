/**
 * Range parsing for media delivery.
 *
 * Without it the route answers every request with the whole file and no
 * Accept-Ranges, so a <video> scrubber either refuses to seek or restarts the
 * download from byte zero. The parsing is fiddly enough to be worth pinning:
 * ranges are inclusive, open-ended, and a malformed one must be ignored rather
 * than trusted.
 */
import { test, expect, describe } from 'bun:test'
import { parseRange } from './routes/media.ts'

const SIZE = 1000

describe('parseRange', () => {
  test('a closed range is inclusive of both ends', () => {
    expect(parseRange('bytes=0-499', SIZE)).toEqual({ start: 0, end: 499 })
    expect(parseRange('bytes=500-999', SIZE)).toEqual({ start: 500, end: 999 })
  })

  test('an open-ended range runs to the last byte', () => {
    expect(parseRange('bytes=500-', SIZE)).toEqual({ start: 500, end: 999 })
    // What a browser sends first to discover the length.
    expect(parseRange('bytes=0-', SIZE)).toEqual({ start: 0, end: 999 })
  })

  test('a suffix range counts back from the end', () => {
    expect(parseRange('bytes=-200', SIZE)).toEqual({ start: 800, end: 999 })
    // Asking for more than exists yields the whole file, not a negative start.
    expect(parseRange('bytes=-5000', SIZE)).toEqual({ start: 0, end: 999 })
  })

  test('an end past the last byte is clamped', () => {
    expect(parseRange('bytes=900-99999', SIZE)).toEqual({ start: 900, end: 999 })
  })

  test('no header means no range', () => {
    expect(parseRange(null, SIZE)).toBeNull()
    expect(parseRange('', SIZE)).toBeNull()
  })

  test('junk is ignored rather than guessed at', () => {
    expect(parseRange('lines=0-10', SIZE)).toBeNull()
    expect(parseRange('bytes=abc', SIZE)).toBeNull()
    expect(parseRange('bytes=', SIZE)).toBeNull()
  })

  test('an unsatisfiable range is rejected, not clamped', () => {
    // Starting at or past the end has no valid representation; the caller must
    // answer 416 rather than serve bytes the client did not ask for.
    expect(parseRange('bytes=1000-', SIZE)).toBe('unsatisfiable')
    expect(parseRange('bytes=1500-1600', SIZE)).toBe('unsatisfiable')
    expect(parseRange('bytes=500-400', SIZE)).toBe('unsatisfiable')
  })

  test('a multi-range request falls back to the whole file', () => {
    // Legal HTTP, but it needs a multipart body. Serving everything is a
    // correct, if unhelpful, response and keeps the encoder out of this file.
    expect(parseRange('bytes=0-99,200-299', SIZE)).toBeNull()
  })

  test('a zero-length object cannot satisfy any range', () => {
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable')
  })
})
