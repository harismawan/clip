import { EXPORT_SIZES, FREE_VIDEO_ALLOWANCE } from '../data/fixtures'
import type { Clip, Ratio } from '../types'

export function quota(videosUsed: number) {
  return {
    label: `${FREE_VIDEO_ALLOWANCE - videosUsed} of ${FREE_VIDEO_ALLOWANCE} free videos left`,
    usedLabel: `${videosUsed} of ${FREE_VIDEO_ALLOWANCE}`,
    width: `${Math.round((videosUsed / FREE_VIDEO_ALLOWANCE) * 100)}%`,
  }
}

export function formatsLabel(formats: Record<Ratio, boolean>): string {
  const on = (Object.keys(formats) as Ratio[]).filter((k) => formats[k])
  return on.join(' and ') || 'none selected'
}

export function exportLabel(filter: Ratio, subs: boolean): string {
  return EXPORT_SIZES[filter] + (subs ? ' · subtitles burned in' : '')
}

/** The CSS aspect ratio for cards under the current format tab. */
export function clipAspect(filter: Ratio): string {
  return filter === '1:1' ? '1/1' : filter === '4:5' ? '4/5' : '9/16'
}

export function sortClips(clips: Clip[], byScore: boolean): Clip[] {
  return byScore ? [...clips].sort((a, b) => b.sc - a.sc) : [...clips].sort((a, b) => a.s - b.s)
}

export function selectedCount(clips: Clip[]): number {
  return clips.filter((c) => c.selected).length
}

export function clipTitle(clip: Clip): string {
  return clip.title || clip.t
}
