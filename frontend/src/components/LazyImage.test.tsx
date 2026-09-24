/**
 * What an image and a video look like before they have loaded -- the state a
 * user on a slow connection actually sits and looks at.
 *
 * Static markup, so this is the first render only. The load and error
 * transitions need a browser; they were checked in headless Chromium.
 */
import { test, expect, describe } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { LazyImage } from './LazyImage'
import { ClipPlayer } from './ClipPlayer'
import type { Clip } from '../types'

describe('LazyImage, before it loads', () => {
  const html = renderToStaticMarkup(
    <LazyImage src="/t.jpg" fallbackClassName="hatch-sand" className="w-[82px] rounded-[7px]" />,
  )

  test('pulses, and says it is busy', () => {
    expect(html).toContain('motion-safe:animate-pulse')
    expect(html).toContain('aria-busy="true"')
  })

  test('the image waits invisibly, to fade in rather than pop', () => {
    expect(html).toContain('opacity-0')
    expect(html).toContain('transition-opacity')
  })

  /** Twenty-four thumbnails must not all load before the first is on screen. */
  test('loads lazily and decodes off the main thread', () => {
    expect(html).toContain('loading="lazy"')
    expect(html).toContain('decoding="async"')
  })

  test('the caller sizes the box, and the fallback waits for a failure', () => {
    expect(html).toContain('w-[82px] rounded-[7px]')
    expect(html).not.toContain('hatch-sand')
  })

  test('passes image attributes through, e.g. the avatar referrer policy', () => {
    const avatar = renderToStaticMarkup(<LazyImage src="/a.jpg" referrerPolicy="no-referrer" />)
    expect(avatar).toContain('referrerPolicy="no-referrer"')
    expect(avatar).toContain('alt=""')
  })
})

describe('ClipPlayer, before the video loads', () => {
  const clip = {
    id: 'c1',
    t: 'Bahaya Bicara Ekonomi',
    s: 0,
    e: 43,
    renders: { '9:16': { url: '/c1.mp4' } },
  } as unknown as Clip

  const html = renderToStaticMarkup(<ClipPlayer clip={clip} ratio="9:16" onClose={() => {}} />)

  test('says the video is loading over the black box', () => {
    expect(html).toContain('Loading video…')
    expect(html).toContain('role="status"')
  })

  /** Otherwise it is a 300x150 box that jumps when the first frame lands. */
  test('holds the render shape while it loads', () => {
    expect(html).toContain('aspect-ratio:9/16')
  })
})
