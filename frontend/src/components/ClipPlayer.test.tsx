/**
 * The clip player overlay.
 *
 * Driven by props rather than context so it can be rendered to static markup
 * without an app provider, the same reason JobIndicator takes props.
 */
import { test, expect, describe } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ClipPlayer } from './ClipPlayer'
import type { Clip, Ratio, Render } from '../types'

const render = (over: Partial<Render> = {}): Render => ({
  ratio: '9:16',
  url: 'https://api.test/api/media/c1.mp4?ratio=9%3A16&exp=1&sig=x',
  thumbUrl: 'https://api.test/api/media/c1.jpg?ratio=9%3A16&exp=1&sig=x',
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
  t: 'The pricing mistake everyone makes',
  s: 2238,
  e: 2293,
  sc: 88,
  sn: 'charge for the outcome',
  cap: 'Stop charging for hours.',
  line: 'charge for the outcome',
  status: 'ready',
  renders: { '9:16': render() },
  ...over,
})

const html = (c: Clip | null, ratio: Ratio = '9:16') =>
  renderToStaticMarkup(<ClipPlayer clip={c} ratio={ratio} onClose={() => {}} />)

describe('ClipPlayer', () => {
  test('renders nothing when no clip is open', () => {
    expect(html(null)).toBe('')
  })

  test('plays the render for the chosen ratio', () => {
    const markup = html(clip())
    expect(markup).toContain('<video')
    expect(markup).toContain('api/media/c1.mp4')
  })

  test('is a labelled modal so assistive tech can announce it', () => {
    const markup = html(clip())
    expect(markup).toContain('role="dialog"')
    expect(markup).toContain('aria-modal="true"')
    expect(markup).toContain('The pricing mistake everyone makes')
  })

  test('offers a close control', () => {
    expect(html(clip())).toContain('aria-label="Close player"')
  })

  test('falls back to a message when that ratio has no playable render', () => {
    // renders[ratio] is absent for a format the job never produced, and url is
    // null until the render finishes -- neither can be handed to <video>.
    const missing = html(clip({ renders: {} }))
    expect(missing).not.toContain('<video')
    expect(missing).toContain('not ready')

    const unfinished = html(clip({ renders: { '9:16': render({ url: null, status: 'rendering' }) } }))
    expect(unfinished).not.toContain('<video')
  })

  test('picks the render matching the requested ratio, not merely the first', () => {
    const c = clip({
      renders: {
        '9:16': render({ url: 'https://api.test/api/media/c1.mp4?ratio=9%3A16' }),
        '1:1': render({ ratio: '1:1', url: 'https://api.test/api/media/c1.mp4?ratio=1%3A1' }),
      },
    })
    expect(html(c, '1:1')).toContain('ratio=1%3A1')
  })
})
