/**
 * Argument parsing and age reporting for the proxies script.
 *
 * `--sweep` deletes files, so an unrecognised flag must be an error rather than
 * something quietly ignored next to it.
 */
import { test, expect, describe } from 'bun:test'
import { parseArgs, daysSince } from './proxies.ts'

describe('parseArgs', () => {
  test('lists without deleting by default', () => {
    expect(parseArgs([])).toEqual({ sweep: false })
  })

  test('--sweep opts into the deleting', () => {
    expect(parseArgs(['--sweep'])).toEqual({ sweep: true })
  })

  test('an unknown flag is an error, not something ignored beside --sweep', () => {
    expect(() => parseArgs(['--swep'])).toThrow(/--swep/)
    expect(() => parseArgs(['--sweep', '--force'])).toThrow(/--force/)
  })
})

describe('daysSince', () => {
  const now = new Date('2026-09-22T12:00:00Z')

  test('counts whole days', () => {
    expect(daysSince(new Date('2026-09-20T12:00:00Z'), now)).toBe(2)
  })

  test('rounds down, so "today" is 0 rather than 1', () => {
    expect(daysSince(new Date('2026-09-22T00:00:01Z'), now)).toBe(0)
  })

  test('never used is null, not zero', () => {
    // Zero would read as "used today", which is the opposite of the truth and
    // would make it look like the least likely thing to be evicted.
    expect(daysSince(null, now)).toBeNull()
  })
})
