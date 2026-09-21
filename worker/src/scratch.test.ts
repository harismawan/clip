/**
 * Who owns a cached download.
 *
 * The bug this prevents: `videos.scratch_path` is global, but the file it names
 * lives inside one operation's scratch directory. A re-cut that adopted a
 * running job's download would have it deleted underneath it the moment that
 * job finished and cleaned up -- failing mid-render, on a file it never
 * created.
 */
import { test, expect, describe } from 'bun:test'
import { ownsScratch } from './scratch.ts'

describe('ownsScratch', () => {
  test('a file inside this operation directory is ours', () => {
    expect(ownsScratch('/work/job-1/source.mp4', '/work/job-1')).toBe(true)
  })

  test('another operation directory is not ours, however similar', () => {
    expect(ownsScratch('/work/job-2/source.mp4', '/work/job-1')).toBe(false)
    expect(ownsScratch('/work/recut-abc/source.mp4', '/work/job-1')).toBe(false)
  })

  test('a sibling with our name as a prefix is NOT ours', () => {
    // The whole point of not using a bare startsWith: job-1 must not claim
    // job-10's download and delete it on cleanup.
    expect(ownsScratch('/work/job-10/source.mp4', '/work/job-1')).toBe(false)
    expect(ownsScratch('/work/job-1-old/source.mp4', '/work/job-1')).toBe(false)
  })

  test('a trailing slash on the directory changes nothing', () => {
    expect(ownsScratch('/work/job-1/source.mp4', '/work/job-1/')).toBe(true)
  })

  test('a nested file is still ours', () => {
    expect(ownsScratch('/work/job-1/nested/source.mp4', '/work/job-1')).toBe(true)
  })

  test('the directory itself is not a file we own', () => {
    expect(ownsScratch('/work/job-1', '/work/job-1')).toBe(false)
  })

  test('relative or odd paths are normalised before comparing', () => {
    expect(ownsScratch('/work/job-1/../job-2/source.mp4', '/work/job-1')).toBe(false)
    expect(ownsScratch('/work/job-1/./source.mp4', '/work/job-1')).toBe(true)
  })

  test('no path at all is not ours', () => {
    expect(ownsScratch('', '/work/job-1')).toBe(false)
  })
})
