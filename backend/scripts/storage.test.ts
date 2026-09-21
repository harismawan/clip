/**
 * Argument parsing for the storage script.
 *
 * Worth its own tests because two of these commands are load-bearing: `activate`
 * redirects every future upload, and `remove` deletes a backend row. Both are
 * typed by hand, at speed, against production.
 */
import { test, expect, describe } from 'bun:test'
import { parseArgs } from './storage.ts'

describe('storage script arguments', () => {
  test('no arguments lists every backend', () => {
    expect(parseArgs([])).toMatchObject({ command: 'list' })
  })

  test('add takes the routing fields', () => {
    const args = parseArgs(['add', 's3-jkt', '--bucket', 'clip-prod', '--region', 'ap-southeast-3'])
    expect(args).toMatchObject({
      command: 'add',
      id: 's3-jkt',
      bucket: 'clip-prod',
      region: 'ap-southeast-3',
      pathStyle: false,
    })
    // No --endpoint means real AWS, addressed by region.
    expect(args.endpoint).toBeUndefined()
  })

  test('add defaults to virtual-host style, which is what real AWS wants', () => {
    const args = parseArgs(['add', 's3', '--bucket', 'b', '--region', 'r'])
    expect(args).toMatchObject({ pathStyle: false })
  })

  test('--path-style opts into the MinIO addressing mode', () => {
    const args = parseArgs(['add', 'mini2', '--bucket', 'b', '--region', 'r', '--path-style'])
    expect(args).toMatchObject({ pathStyle: true })
  })

  test('add without a bucket or region is an error, not a half-made row', () => {
    expect(() => parseArgs(['add', 's3', '--region', 'r'])).toThrow(/bucket/i)
    expect(() => parseArgs(['add', 's3', '--bucket', 'b'])).toThrow(/region/i)
  })

  test('an id that cannot become an env var name is rejected at add', () => {
    // The id derives STORAGE_<ID>_ACCESS_KEY; anything else silently reads as
    // "credentials missing" later, which sends you hunting in the wrong place.
    expect(() => parseArgs(['add', 'S3 Prod', '--bucket', 'b', '--region', 'r'])).toThrow()
    expect(() => parseArgs(['add', 's3_prod', '--bucket', 'b', '--region', 'r'])).toThrow()
    expect(() => parseArgs(['add', 's3.prod', '--bucket', 'b', '--region', 'r'])).toThrow()
  })

  test('a lowercase dashed id is accepted', () => {
    expect(parseArgs(['add', 's3-jkt-2', '--bucket', 'b', '--region', 'r'])).toMatchObject({
      id: 's3-jkt-2',
    })
  })

  test('activate names one backend', () => {
    expect(parseArgs(['activate', 's3-jkt'])).toMatchObject({ command: 'activate', id: 's3-jkt' })
  })

  test('verify names one backend', () => {
    expect(parseArgs(['verify', 'minio'])).toMatchObject({ command: 'verify', id: 'minio' })
  })

  test('remove is a dry run until --yes', () => {
    expect(parseArgs(['remove', 'typo'])).toMatchObject({ confirmed: false })
    expect(parseArgs(['remove', 'typo', '--yes'])).toMatchObject({ confirmed: true })
  })

  test('the commands that act on one backend refuse to run without an id', () => {
    for (const command of ['add', 'activate', 'verify', 'remove']) {
      expect(() => parseArgs([command])).toThrow()
    }
  })

  test('an unknown command is an error rather than a silent list', () => {
    expect(() => parseArgs(['destroy', 'minio'])).toThrow(/destroy/)
  })

  test('an unknown flag is an error rather than being read as an id', () => {
    expect(() => parseArgs(['verify', 'minio', '--force'])).toThrow(/--force/)
  })
})
