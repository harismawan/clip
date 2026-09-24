/**
 * Argument parsing for the jobs script.
 *
 * `delete --yes` removes files for good, so everything short of exactly that
 * must stop: a typo'd flag, a stray second id, or something that is not an id
 * at all (it ends up in a LIKE pattern, parameterised or not).
 */
import { test, expect, describe } from 'bun:test'
import { parseArgs } from './jobs.ts'

describe('parseArgs', () => {
  test('lists by default', () => {
    expect(parseArgs([])).toEqual({ cmd: 'list' })
    expect(parseArgs(['list'])).toEqual({ cmd: 'list' })
  })

  test('cancel takes an id or a prefix of one', () => {
    expect(parseArgs(['cancel', 'c397ca27'])).toEqual({ cmd: 'cancel', id: 'c397ca27' })
    expect(parseArgs(['cancel', 'C397CA27-6db9'])).toEqual({ cmd: 'cancel', id: 'c397ca27-6db9' })
  })

  test('delete asks unless --yes is given', () => {
    expect(parseArgs(['delete', 'c397ca27'])).toEqual({ cmd: 'delete', id: 'c397ca27', yes: false })
    expect(parseArgs(['delete', 'c397ca27', '--yes'])).toEqual({ cmd: 'delete', id: 'c397ca27', yes: true })
    expect(parseArgs(['delete', '--yes', 'c397ca27'])).toEqual({ cmd: 'delete', id: 'c397ca27', yes: true })
  })

  test('a typo in the confirming flag stops rather than proceeding', () => {
    expect(() => parseArgs(['delete', 'c397ca27', '--yse'])).toThrow(/--yse/)
    expect(() => parseArgs(['delete', 'c397ca27', '--force'])).toThrow(/--force/)
  })

  test('--yes means nothing to cancel, so it is refused there', () => {
    expect(() => parseArgs(['cancel', 'c397ca27', '--yes'])).toThrow(/--yes/)
  })

  test('refuses what is not an id', () => {
    expect(() => parseArgs(['cancel'])).toThrow(/needs a job id/)
    expect(() => parseArgs(['cancel', 'c39'])).toThrow(/not a job id/) // too short to be specific
    expect(() => parseArgs(['cancel', "c397'; drop"])).toThrow(/not a job id/)
    expect(() => parseArgs(['cancel', '%'])).toThrow(/not a job id/)
  })

  test('one job at a time', () => {
    expect(() => parseArgs(['delete', 'c397ca27', 'deadbeef', '--yes'])).toThrow(/One job at a time/)
  })

  test('unknown commands are errors', () => {
    expect(() => parseArgs(['stop', 'c397ca27'])).toThrow(/Unknown command stop/)
    expect(() => parseArgs(['list', 'extra'])).toThrow(/Unexpected extra/)
  })
})
