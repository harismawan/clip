import { test, expect, describe } from 'bun:test'
import { parseWhisperProgress } from './parse.ts'

/**
 * The prompt-shaping tests that used to sit beside these moved to
 * shared/clipPrompt.test.ts, following the code.
 */
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
