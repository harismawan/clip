/**
 * Which file the editor plays, and where to seek in it.
 *
 * The screen asks "what can I play and what does it cover" rather than "is
 * there a proxy", so that a clip cut before proxies existed still shows a
 * picture instead of a hatched box.
 */
import { describe, expect, test } from 'bun:test'
import { previewFor, videoTimeFor } from '../state/useSnipline'
import type { Clip, Render } from '../types'

const render = (over: Partial<Render> = {}): Render => ({
  ratio: '9:16',
  url: 'https://api.test/api/media/c1.mp4?ratio=9%3A16&exp=1&sig=x',
  thumbUrl: null,
  width: 1080,
  height: 1920,
  sizeBytes: 5_000_000,
  status: 'ready',
  ...over,
})

const clip = (over: Partial<Clip> = {}): Clip => ({
  id: 'c1',
  idx: 0,
  selected: false,
  t: 'a moment',
  s: 2238,
  e: 2293,
  sc: 88,
  sn: '',
  cap: '',
  line: '',
  proxyUrl: null,
  stripUrl: null,
  peaks: null,
  win: null,
  status: 'ready',
  renders: { '9:16': render() },
  ...over,
})

describe('previewFor', () => {
  test('prefers the proxy, and reports the window it covers', () => {
    const c = clip({ proxyUrl: 'https://api.test/proxy.mp4', win: { start: 2208, span: 150 } })
    expect(previewFor(c, '9:16')).toEqual({
      url: 'https://api.test/proxy.mp4',
      start: 2208,
      span: 150,
      kind: 'proxy',
    })
  })

  test('falls back to the rendered clip, which covers only the cut', () => {
    const p = previewFor(clip(), '9:16')
    expect(p?.kind).toBe('render')
    expect(p?.start).toBe(2238)
    expect(p?.span).toBe(2293 - 2238)
  })

  test('falls back to the ratio being previewed, not always 9:16', () => {
    const c = clip({
      renders: { '9:16': render(), '1:1': render({ ratio: '1:1', url: 'https://api.test/square.mp4' }) },
    })
    expect(previewFor(c, '1:1')?.url).toBe('https://api.test/square.mp4')
  })

  test('is null when the ratio has no finished render and there is no proxy', () => {
    // Nothing to show: the screen keeps the placeholder rather than rendering a
    // <video> with an empty src, which some browsers treat as an error.
    expect(previewFor(clip({ renders: {} }), '9:16')).toBeNull()
    expect(previewFor(clip({ renders: { '9:16': render({ url: null }) } }), '9:16')).toBeNull()
  })

  test('prefers the proxy even when a render exists', () => {
    const c = clip({ proxyUrl: 'https://api.test/proxy.mp4', win: { start: 0, span: 150 } })
    expect(previewFor(c, '9:16')?.kind).toBe('proxy')
  })
})

describe('videoTimeFor', () => {
  const proxy = { url: '', start: 2208, span: 150, kind: 'proxy' as const }
  const rendered = { url: '', start: 2238, span: 55, kind: 'render' as const }

  test('offsets a source second into the file', () => {
    expect(videoTimeFor(proxy, 2238)).toBe(30)
    expect(videoTimeFor(rendered, 2238)).toBe(0)
    expect(videoTimeFor(rendered, 2250)).toBe(12)
  })

  test('clamps to what the file actually holds', () => {
    // Dragging the in point before the cut is legal on a render-backed preview;
    // the picture holds at the first frame rather than the seek being rejected.
    expect(videoTimeFor(rendered, 2200)).toBe(0)
    expect(videoTimeFor(rendered, 9999)).toBe(55)
    expect(videoTimeFor(proxy, 0)).toBe(0)
  })
})
