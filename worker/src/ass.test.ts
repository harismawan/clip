import { describe, test, expect } from 'bun:test'
import { buildClipAss, assTime, maxCharsPerLineFor, SUBTITLE_SIZE, SUBTITLE_LIFT } from './ass.ts'
import type { TranscriptSegment } from '../../shared/schema.ts'

const segs: TranscriptSegment[] = [
  { start: 10, end: 12, text: 'halo dunia' },
  { start: 12.5, end: 14, text: 'apa kabar' },
]

describe('assTime', () => {
  test('formats as H:MM:SS.cc, the only form libass accepts', () => {
    expect(assTime(0)).toBe('0:00:00.00')
    expect(assTime(83.456)).toBe('0:01:23.46')
    expect(assTime(3661.5)).toBe('1:01:01.50')
  })

  test('clamps negatives rather than emitting a bogus timestamp', () => {
    expect(assTime(-5)).toBe('0:00:00.00')
  })
})

describe('buildClipAss', () => {
  test('declares PlayRes matching the output frame', () => {
    const ass = buildClipAss(segs, 10, 14, 1080, 1920)
    expect(ass).toContain('PlayResX: 1080')
    expect(ass).toContain('PlayResY: 1920')
  })

  /**
   * The bug this file exists for: sizes were written in output pixels but
   * libass read them in the script's PlayRes space, which defaults to 288 tall
   * for an SRT. That scaled the font by 1920/288 = 6.67x and pushed a
   * bottom-aligned cue off the top of the frame.
   */
  test('keeps font size at SUBTITLE_SIZE of the declared PlayResY', () => {
    const ass = buildClipAss(segs, 10, 14, 1080, 1920)
    const style = ass.split('\n').find((l) => l.startsWith('Style: '))!
    const fontSize = Number(style.split(',')[2])
    expect(fontSize / 1920).toBeCloseTo(SUBTITLE_SIZE, 3)
    // Smaller than the old 4.5%, which read as too big on a phone.
    expect(fontSize).toBeLessThan(Math.round(1920 * 0.045))
  })

  test('scales font with output height so 1:1 is not styled like 9:16', () => {
    const size = (h: number) => {
      const style = buildClipAss(segs, 10, 14, 1080, h)
        .split('\n')
        .find((l) => l.startsWith('Style: '))!
      return Number(style.split(',')[2])
    }
    expect(size(1920)).toBeGreaterThan(size(1080))
  })

  test('anchors the text by its bottom edge, so extra lines grow upward', () => {
    const style = buildClipAss(segs, 10, 14, 1080, 1920)
      .split('\n')
      .find((l) => l.startsWith('Style: '))!
    // Alignment is field 19 (1-indexed) in the V4+ Style format.
    expect(style.split(',')[18]).toBe('2')
  })

  /**
   * Lifted to just below the middle: clear of the band at the bottom where
   * TikTok and Reels draw their own UI, and off the usual face position.
   */
  test('sits just below the middle, not at the foot of the frame', () => {
    for (const h of [1920, 1350, 1080]) {
      const style = buildClipAss(segs, 10, 14, 1080, h)
        .split('\n')
        .find((l) => l.startsWith('Style: '))!
      // MarginV is field 22: distance from the bottom edge to the text's bottom.
      const marginV = Number(style.split(',')[21])
      expect(marginV / h).toBeCloseTo(SUBTITLE_LIFT, 2)
      // The text's bottom edge is below the centre line, so it never covers it.
      expect(marginV).toBeLessThan(h / 2)
    }
  })

  test('outlines the text, since white on bright video is unreadable', () => {
    const style = buildClipAss(segs, 10, 14, 1080, 1920)
      .split('\n')
      .find((l) => l.startsWith('Style: '))!
    expect(Number(style.split(',')[16])).toBeGreaterThan(0)
  })

  test('rebases cue timestamps so the clip starts at zero', () => {
    const ass = buildClipAss(segs, 10, 14, 1080, 1920)
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue: '))
    expect(events).toHaveLength(2)
    expect(events[0]).toContain('0:00:00.00,0:00:02.00')
    expect(events[1]).toContain('0:00:02.50,0:00:04.00')
  })

  test('truncates a segment that straddles the clip boundary', () => {
    const ass = buildClipAss([{ start: 8, end: 12, text: 'lintas batas' }], 10, 14, 1080, 1920)
    const event = ass.split('\n').find((l) => l.startsWith('Dialogue: '))!
    expect(event).toContain('0:00:00.00,0:00:02.00')
  })

  test('joins wrapped lines with \\N, since a raw newline ends the event', () => {
    // An explicit width, so the test is about joining, not about which text
    // happens to overflow at the current font size.
    const ass = buildClipAss([{ start: 10, end: 13, text: 'satu dua tiga empat' }], 10, 14, 1080, 1920, {
      maxCharsPerLine: 10,
    })
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue: '))
    expect(events).toHaveLength(1)
    expect(events[0]).toContain('\\N')
  })

  /**
   * A narrower line limit must not cost words. Capping at maxLines and
   * discarding the rest would silently drop the end of every long segment.
   */
  test('splits a long cue into sequential events instead of dropping words', () => {
    const text =
      'satu dua tiga empat lima enam tujuh delapan sembilan sepuluh sebelas duabelas tigabelas'
    const ass = buildClipAss([{ start: 0, end: 8, text }], 0, 8, 1080, 1920)
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue: '))

    expect(events.length).toBeGreaterThan(1)

    const spoken = events
      .map((e) => e.split(',').slice(9).join(','))
      .join(' ')
      .replace(/\\N/g, ' ')
    for (const word of text.split(' ')) expect(spoken).toContain(word)
  })

  test('keeps split events inside the original cue span and in order', () => {
    const text =
      'satu dua tiga empat lima enam tujuh delapan sembilan sepuluh sebelas duabelas tigabelas'
    const ass = buildClipAss([{ start: 0, end: 8, text }], 0, 8, 1080, 1920)
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue: '))

    const times = events.map((e) => {
      const f = e.split(',')
      return { start: f[1], end: f[2] }
    })

    expect(times[0].start).toBe('0:00:00.00')
    expect(times[times.length - 1].end).toBe('0:00:08.00')
    for (let i = 1; i < times.length; i++) {
      expect(times[i].start).toBe(times[i - 1].end)
    }
  })

  test('strips braces so transcript text cannot inject override tags', () => {
    const ass = buildClipAss([{ start: 10, end: 12, text: 'a {\\fs300} b' }], 10, 14, 1080, 1920)
    const event = ass.split('\n').find((l) => l.startsWith('Dialogue: '))!
    expect(event).not.toContain('{')
    expect(event).not.toContain('}')
  })

  test('returns empty string when nothing overlaps, so the caller can skip burning', () => {
    expect(buildClipAss(segs, 100, 120, 1080, 1920)).toBe('')
  })

  /**
   * WrapStyle 2 tells libass not to re-wrap, so a line we emit too long does
   * not get rescued -- it runs off both edges of the frame. The limit has to
   * come from the geometry, not a constant inherited from the SRT path.
   */
  test('never emits a line wider than the frame can show', () => {
    const text = 'Jangan tunda hidupmu sampai besok karena waktu tidak kembali'
    const ass = buildClipAss([{ start: 0, end: 3, text }], 0, 3, 1080, 1920)

    const style = ass.split('\n').find((l) => l.startsWith('Style: '))!.split(',')
    const fontSize = Number(style[2])
    const usable = 1080 - Number(style[19]) - Number(style[20])

    const event = ass.split('\n').find((l) => l.startsWith('Dialogue: '))!
    const body = event.split(',').slice(9).join(',')

    for (const line of body.split('\\N')) {
      expect(line.length).toBeLessThanOrEqual(maxCharsPerLineFor(1080, fontSize, Number(style[19])))
      expect(line.length * fontSize * 0.6).toBeLessThanOrEqual(usable)
    }
  })
})

describe('maxCharsPerLineFor', () => {
  test('fits roughly 18 characters across a 1080-wide 9:16 frame', () => {
    expect(maxCharsPerLineFor(1080, 86, 65)).toBeGreaterThanOrEqual(14)
    expect(maxCharsPerLineFor(1080, 86, 65)).toBeLessThanOrEqual(22)
  })

  test('allows more characters as the font shrinks', () => {
    expect(maxCharsPerLineFor(1080, 48, 65)).toBeGreaterThan(maxCharsPerLineFor(1080, 86, 65))
  })

  test('never collapses to an unusable limit on a narrow frame', () => {
    expect(maxCharsPerLineFor(200, 86, 65)).toBeGreaterThanOrEqual(8)
  })
})
