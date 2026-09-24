/**
 * ASS subtitle generation for burn-in.
 *
 * Why build ASS rather than hand the SRT to ffmpeg's `subtitles` filter with
 * `force_style`: libass reads every size in the *script's* PlayRes coordinate
 * space, not in output pixels. ffmpeg's internal SRT->ASS conversion writes a
 * default header of 384x288, so a FontSize computed against the output height
 * was scaled by outHeight/288 -- 6.67x at 1920 -- and a bottom margin scaled
 * the same way pushed a bottom-aligned cue clean off the top of the frame.
 *
 * Declaring PlayRes ourselves is what makes "sizes are in output pixels" true.
 *
 * Pure functions, no I/O.
 */
import type { TranscriptSegment } from '../../shared/schema.ts'
import { wrapLines } from './srt.ts'

/** Seconds -> "0:01:23.46". ASS uses centiseconds and a single-digit hour. */
export function assTime(seconds: number): string {
  const cs = Math.round(Math.max(0, seconds) * 100)
  const h = Math.floor(cs / 360_000)
  const m = Math.floor((cs % 360_000) / 6_000)
  const s = Math.floor((cs % 6_000) / 100)
  const c = cs % 100
  const p = (n: number) => String(n).padStart(2, '0')
  return `${h}:${p(m)}:${p(s)}.${p(c)}`
}

export interface AssOptions {
  /** Wrap to at most this many characters per line. Derived from the frame if omitted. */
  maxCharsPerLine?: number
  /** At most this many lines per cue; extra text is dropped, not overflowed. */
  maxLines?: number
}

/**
 * Mean glyph advance as a fraction of font size, for bold DejaVu Sans over
 * mixed-case Latin. Deliberately on the generous side: under-filling a line
 * costs nothing, while over-filling runs the text off both edges, because
 * `WrapStyle: 2` stops libass from re-wrapping what we emit.
 */
const AVG_ADVANCE_EM = 0.6

/**
 * Where the burned-in text sits and how big it is, as fractions of the frame
 * height. The two knobs to turn if the look needs tuning.
 *
 * Just below the middle, not at the foot of the frame. The bottom band is where
 * TikTok and Reels draw their own caption, handle and buttons, so text there is
 * half-covered once posted; the dead centre is usually the speaker's face.
 * Anchored by its bottom edge (alignment 2) and lifted SUBTITLE_LIFT of the
 * height, so a two-line cue grows UP toward the middle, never down into that UI
 * band. At 9:16 that puts a two-line cue across roughly 55-62% of the height.
 *
 * Size was 4.5% and sat 12% up from the bottom; asked for higher and smaller.
 */
export const SUBTITLE_SIZE = 0.035
export const SUBTITLE_LIFT = 0.38

/** How many characters fit across the frame at this font size. */
export function maxCharsPerLineFor(outWidth: number, fontSize: number, marginH: number): number {
  const usable = outWidth - 2 * marginH
  return Math.max(8, Math.floor(usable / (fontSize * AVG_ADVANCE_EM)))
}

/**
 * Transcript text is not trusted markup: a stray `{` opens an ASS override
 * block and everything after it stops rendering as words.
 */
function sanitise(text: string): string {
  return text
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Build a burnable ASS file covering [start, end), with timestamps rebased so
 * the clip begins at zero. Returns '' when no cue overlaps, so the caller can
 * skip the subtitles filter rather than pass an empty file.
 *
 * Segments straddling a boundary are kept and truncated, because dropping them
 * would silently lose the first or last words of the clip -- usually the hook.
 */
export function buildClipAss(
  segments: TranscriptSegment[],
  start: number,
  end: number,
  outWidth: number,
  outHeight: number,
  opts: AssOptions = {},
): string {
  const maxLines = opts.maxLines ?? 2
  const duration = end - start

  const cues = segments
    .filter((s) => s.end > start && s.start < end)
    .map((s) => ({
      start: Math.max(0, s.start - start),
      end: Math.min(duration, s.end - start),
      text: sanitise(s.text),
    }))
    .filter((c) => c.text.length > 0 && c.end > c.start)
    .sort((a, b) => a.start - b.start)

  if (cues.length === 0) return ''

  const fontSize = Math.round(outHeight * SUBTITLE_SIZE)
  const outline = Math.max(2, Math.round(fontSize * 0.12))
  const marginV = Math.round(outHeight * SUBTITLE_LIFT)
  const marginH = Math.round(outWidth * 0.06)
  const maxChars = opts.maxCharsPerLine ?? maxCharsPerLineFor(outWidth, fontSize, marginH)

  const events = cues.flatMap((c) => {
    // Wrap without a line cap, then group into screens. Capping here instead
    // would throw away every word past the second line.
    const lines = wrapLines(c.text, maxChars, Number.MAX_SAFE_INTEGER)
    const screens: string[][] = []
    for (let i = 0; i < lines.length; i += maxLines) {
      screens.push(lines.slice(i, i + maxLines))
    }

    // Share the cue's time between screens by character count, so a dense
    // screen is not on-frame for the same beat as a two-word one.
    const weights = screens.map((s) => s.join(' ').length)
    const total = weights.reduce((n, w) => n + w, 0) || 1
    const span = c.end - c.start

    let at = c.start
    return screens.map((screen, i) => {
      // Land the final end exactly on the cue boundary rather than on a sum
      // of rounded shares.
      const end = i === screens.length - 1 ? c.end : at + (weights[i] / total) * span
      const line = `Dialogue: 0,${assTime(at)},${assTime(end)},Default,,0,0,0,,${screen.join('\\N')}`
      at = end
      return line
    })
  })

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${outWidth}`,
    `PlayResY: ${outHeight}`,
    // Without this the outline keeps its authored width while the text scales.
    'ScaledBorderAndShadow: yes',
    // We wrap ourselves in wrapLines; libass must not re-wrap on top of that.
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour,' +
      ' BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle,' +
      ' BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,DejaVu Sans,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,` +
      `-1,0,0,0,100,100,0,0,1,${outline},0,2,${marginH},${marginH},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n')
}
