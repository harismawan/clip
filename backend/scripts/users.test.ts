/**
 * Argument parsing for the users script.
 *
 * Worth testing on its own because one of these flags deletes an account and
 * every clip under it. A parser that mistook a stray argument for an email, or
 * let --delete through without its confirmation, would do that to the wrong
 * person.
 */
import { test, expect, describe } from 'bun:test'
import { parseArgs } from './users.ts'

describe('users script arguments', () => {
  test('no arguments lists everyone', () => {
    expect(parseArgs([])).toEqual({
      email: undefined,
      signOut: false,
      remove: false,
      confirmed: false,
    })
  })

  test('an email alone is a read-only detail view', () => {
    expect(parseArgs(['a@b.com'])).toEqual({
      email: 'a@b.com',
      signOut: false,
      remove: false,
      confirmed: false,
    })
  })

  test('--signout revokes sessions', () => {
    expect(parseArgs(['a@b.com', '--signout'])).toMatchObject({ signOut: true, remove: false })
  })

  test('--delete asks for the account to be removed', () => {
    expect(parseArgs(['a@b.com', '--delete'])).toMatchObject({ remove: true, confirmed: false })
  })

  test('--yes is what actually confirms it', () => {
    expect(parseArgs(['a@b.com', '--delete', '--yes'])).toMatchObject({
      remove: true,
      confirmed: true,
    })
  })

  test('acting on nobody is an error, not an action on everybody', () => {
    // The dangerous shape: `--delete` with no email must never mean "all".
    expect(() => parseArgs(['--delete'])).toThrow()
    expect(() => parseArgs(['--signout'])).toThrow()
  })

  test('an unknown flag is an error rather than being read as an email', () => {
    expect(() => parseArgs(['a@b.com', '--purge'])).toThrow()
  })

  test('a second bare argument is an error, not a silent overwrite', () => {
    expect(() => parseArgs(['a@b.com', 'c@d.com'])).toThrow()
  })
})
