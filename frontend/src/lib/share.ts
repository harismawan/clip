/**
 * Hand a rendered clip to the phone's share sheet -- which is how it reaches
 * TikTok, Reels or WhatsApp without the user saving a file and re-uploading it.
 *
 * The Web Share API rather than TikTok's own posting API: no developer app, no
 * audit, no tokens to store, and the user lands in TikTok's own editor to write
 * the caption. It only works where the browser can share FILES (iOS Safari,
 * Android Chrome), which is exactly where posting to TikTok happens.
 *
 * Kept free of React and of the global navigator, so both can be faked in tests.
 */
import { slugify } from '../../../shared/format'

/** The shape of navigator this needs. Lib-typed Navigator has it optional. */
export interface ShareNav {
  canShare?: (data: ShareData) => boolean
  share?: (data: ShareData) => Promise<void>
}

/**
 * The same name the server gives a downloaded clip (routes/media.ts), so a
 * shared file and a downloaded one of the same clip are called the same thing.
 */
export function clipFileName(idx: number, title: string): string {
  return `${String(idx + 1).padStart(2, '0')}_${slugify(title || 'clip')}.mp4`
}

/**
 * Can this browser put a video FILE in the share sheet?
 *
 * Sharing a link is widely supported; sharing a file is not, and a link is no
 * use to TikTok. So this asks about a file specifically. A throw counts as no:
 * some browsers throw on File or canShare rather than answering.
 */
export function canShareFiles(nav: ShareNav | undefined = globalThis.navigator): boolean {
  try {
    if (!nav?.canShare || !nav.share) return false
    return nav.canShare({ files: [new File([''], 'probe.mp4', { type: 'video/mp4' })] })
  } catch {
    return false
  }
}

/**
 * - `shared`: the sheet opened and the user picked somewhere.
 * - `cancelled`: they dismissed it. Not an error; say nothing.
 * - `needs-tap`: the browser refused because the tap that started this is too
 *   old. iOS Safari only opens the sheet close to a user gesture, and fetching a
 *   10-20MB clip first can outlast that. The caller keeps the file and asks for
 *   one more tap, which then opens the sheet at once.
 */
export type ShareOutcome = 'shared' | 'cancelled' | 'needs-tap'

export async function shareFile(nav: ShareNav, file: File, title: string): Promise<ShareOutcome> {
  try {
    // Files and a title only. Adding `text` makes some Android targets drop
    // the file and share the text alone.
    await nav.share!({ files: [file], title })
    return 'shared'
  } catch (e) {
    const name = (e as { name?: string } | null)?.name
    if (name === 'AbortError') return 'cancelled'
    if (name === 'NotAllowedError') return 'needs-tap'
    throw e
  }
}
