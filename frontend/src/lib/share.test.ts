/**
 * The share-sheet decisions, against fake navigators.
 *
 * What matters: the button must not appear where it cannot work, a dismissed
 * sheet is not an error, and iOS's "that tap is too old" is recognised as a
 * reason to ask for another tap rather than as a failure.
 */
import { test, expect, describe } from 'bun:test'
import { canShareFiles, clipFileName, shareFile, type ShareNav } from './share'

const file = new File(['x'], '01_clip.mp4', { type: 'video/mp4' })
const rejecting = (name: string): ShareNav => ({
  canShare: () => true,
  share: () => Promise.reject(Object.assign(new Error(name), { name })),
})

describe('canShareFiles', () => {
  test('yes where files can be shared', () => {
    expect(canShareFiles({ canShare: () => true, share: async () => {} })).toBe(true)
  })

  test('no where only links can be shared -- a link is no use to TikTok', () => {
    expect(canShareFiles({ canShare: (d) => !d.files, share: async () => {} })).toBe(false)
  })

  test('no without the API at all, or with half of it', () => {
    expect(canShareFiles(undefined)).toBe(false)
    expect(canShareFiles({})).toBe(false)
    expect(canShareFiles({ canShare: () => true })).toBe(false)
  })

  test('a browser that throws instead of answering counts as no', () => {
    expect(
      canShareFiles({
        canShare: () => {
          throw new TypeError('nope')
        },
        share: async () => {},
      }),
    ).toBe(false)
  })
})

describe('shareFile', () => {
  test('shares the file with a title and nothing else', async () => {
    let sent: ShareData | undefined
    const nav: ShareNav = { share: async (d) => void (sent = d) }
    expect(await shareFile(nav, file, 'Bahaya Bicara Ekonomi')).toBe('shared')
    // `text` alongside files makes some Android targets drop the file.
    expect(sent).toEqual({ files: [file], title: 'Bahaya Bicara Ekonomi' })
  })

  test('a dismissed sheet is a cancel, not an error', async () => {
    expect(await shareFile(rejecting('AbortError'), file, 't')).toBe('cancelled')
  })

  /** iOS Safari: the fetch outlasted the tap's gesture window. */
  test('an expired gesture asks for another tap', async () => {
    expect(await shareFile(rejecting('NotAllowedError'), file, 't')).toBe('needs-tap')
  })

  test('anything else is a real failure, for the caller to report', async () => {
    await expect(shareFile(rejecting('DataError'), file, 't')).rejects.toThrow('DataError')
  })
})

describe('clipFileName', () => {
  /** Matches the server's Content-Disposition name in routes/media.ts. */
  test('numbered from 01 and slugged like a download', () => {
    expect(clipFileName(0, 'Bahaya Bicara Ekonomi')).toBe('01_Bahaya_Bicara_Ekonomi.mp4')
    expect(clipFileName(11, 'Negara Berbisnis Sama Rakyat?')).toBe('12_Negara_Berbisnis_Sama_Rakyat.mp4')
  })

  test('an empty title still yields a usable name', () => {
    expect(clipFileName(2, '')).toBe('03_clip.mp4')
  })
})
