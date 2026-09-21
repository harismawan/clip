/**
 * Argument parsing for the quota script.
 *
 * Split out from the database work so the part that can silently do the wrong
 * thing -- "--limit 0" meaning "block this user" versus meaning "no value" --
 * is testable without a Postgres.
 */
import { test, expect, describe } from 'bun:test'
import { parseArgs } from './quota.ts'

describe('quota script arguments', () => {
  test('an email alone is a read-only status check', () => {
    expect(parseArgs(['a@b.com'])).toEqual({
      email: 'a@b.com',
      limit: undefined,
      release: false,
    })
  })

  test('--limit sets a per-user override', () => {
    expect(parseArgs(['a@b.com', '--limit', '20'])).toEqual({
      email: 'a@b.com',
      limit: 20,
      release: false,
    })
  })

  test('--limit default clears the override', () => {
    // null is the value written to the column, which is what makes the user
    // follow QUOTA_JOBS_PER_DAY again.
    expect(parseArgs(['a@b.com', '--limit', 'default'])).toEqual({
      email: 'a@b.com',
      limit: null,
      release: false,
    })
  })

  test('--limit 0 is a real value, not a missing one', () => {
    expect(parseArgs(['a@b.com', '--limit', '0'])).toMatchObject({ limit: 0 })
  })

  test('--release asks to clear a stuck running job', () => {
    expect(parseArgs(['a@b.com', '--release'])).toMatchObject({ release: true })
  })

  test('both at once', () => {
    expect(parseArgs(['a@b.com', '--release', '--limit', '5'])).toEqual({
      email: 'a@b.com',
      limit: 5,
      release: true,
    })
  })

  test('no email is an error, not a run against every user', () => {
    expect(() => parseArgs([])).toThrow()
    expect(() => parseArgs(['--limit', '5'])).toThrow()
  })

  test('a non-numeric limit is an error rather than NaN in the column', () => {
    expect(() => parseArgs(['a@b.com', '--limit', 'lots'])).toThrow()
    expect(() => parseArgs(['a@b.com', '--limit'])).toThrow()
  })

  test('a negative limit is an error', () => {
    expect(() => parseArgs(['a@b.com', '--limit', '-1'])).toThrow()
  })
})
