/**
 * The editor screen, specifically what it does when its assets are missing.
 *
 * The source video does not survive a job, so every clip made before the editor
 * proxy existed has none -- and the screen still has to be usable for those,
 * because trimming and saving need no video at all.
 */
import { test, expect, describe } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { EditorScreen } from './EditorScreen'
import { AppContext } from '../state/AppContext'
import { trimForClip, windowFor } from '../state/useSnipline'
import type { Snipline } from '../state/useSnipline'
import type { Clip, Render } from '../types'

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
  proxyUrl: null,
  stripUrl: null,
  peaks: null,
  win: null,
  status: 'ready',
  renders: { '9:16': render() },
  ...over,
})

const html = (c: Clip, over: Record<string, unknown> = {}) => {
  const stub = {
    state: {
      clips: [c],
      editing: c.id,
      ratio: '9:16',
      pending: null,
      regenerating: {},
      jobId: 'job-1',
      jobStatus: 'completed',
      stage: null,
      progress: 100,
      ...trimForClip(c),
      ...over,
    },
    trackRef: { current: null },
    say: () => {},
    backToResults: () => {},
    saveTrim: () => {},
    setRatio: () => {},
    setTrim: () => {},
    beginDrag: () => () => {},
    pickRange: () => {},
    resetTrim: () => {},
    redoClip: () => {},
    preparePreview: async () => false,
    refreshJob: async () => null,
    go: () => {},
  } as unknown as Snipline

  return renderToStaticMarkup(
    <AppContext value={stub}>
      <EditorScreen />
    </AppContext>,
  )
}

describe('EditorScreen preview', () => {
  test('plays the proxy when the clip has one', () => {
    const markup = html(clip({ proxyUrl: 'https://api.test/api/media/c1.mp4?kind=proxy' }))
    expect(markup).toContain('<video')
    expect(markup).toContain('kind=proxy')
  })

  test('falls back to the rendered clip, and says the picture stops at the cut', () => {
    // The preview is never empty: every ready clip already has its own finished
    // MP4 in storage, so there is something to see while the proxy is built.
    const markup = html(clip())
    expect(markup).toContain('<video')
    expect(markup).toContain('api/media/c1.mp4')
    expect(markup).toContain('showing the current cut')
    expect(markup).toContain('the picture stops at the cut')
  })

  test('keeps the placeholder only when there is nothing at all to play', () => {
    const markup = html(clip({ renders: {} }))
    expect(markup).not.toContain('<video')
    expect(markup).toContain('hatch-night-lg')
    expect(markup).toContain('no finished render')
  })

  test('disables play when there is nothing to play', () => {
    const markup = html(clip({ renders: {} }))
    expect(markup).toContain('aria-label="Play preview"')
    expect(markup).toContain('disabled=""')
  })

  test('shows the real filmstrip when one exists', () => {
    const markup = html(clip({ stripUrl: 'https://api.test/api/media/c1.jpg?kind=strip' }))
    expect(markup).toContain('kind=strip')
    expect(markup).not.toContain('hatch-night ')
  })

  test('prefers the proxy over the rendered clip once one exists', () => {
    const markup = html(
      clip({ proxyUrl: 'https://api.test/api/media/c1.mp4?kind=proxy', win: { start: 2208, span: 150 } }),
    )
    expect(markup).toContain('kind=proxy')
    // The "current cut only" caveat belongs to the fallback, not to the proxy.
    expect(markup).not.toContain('showing the current cut')
  })
})

describe('EditorScreen crop buttons', () => {
  test('offers only the ratios the job actually rendered', () => {
    // Picking a crop with no file behind it would promise a download that
    // cannot happen -- the buttons choose the preview and the export now.
    const markup = html(clip({ renders: { '9:16': render() } }))
    expect(markup).toContain('This project did not render 1:1.')
    expect(markup).toContain('This project did not render 4:5.')
    expect(markup).not.toContain('This project did not render 9:16.')
  })
})

describe('trim derivation', () => {
  test('opens the handles on the clip, not on a fixed pair of percentages', () => {
    // The prototype used 22% / 54% for every clip, which is the right place for
    // none of them.
    const c = clip({ s: 2238, e: 2293, win: { start: 2208, span: 150 } })
    const { trimIn, trimOut } = trimForClip(c)
    expect(trimIn).toBeCloseTo(20, 5)
    expect(trimOut).toBeCloseTo(((2293 - 2208) / 150) * 100, 5)
  })

  test("prefers the server's window to a recomputed one", () => {
    // A clip near the start of a video cannot have a full lead-in, so the proxy
    // begins at 0 and the timeline must agree or it maps to the wrong frames.
    const c = clip({ s: 10, e: 40, win: { start: 0, span: 150 } })
    expect(windowFor(c)).toEqual({ start: 0, span: 150 })
    expect(trimForClip(c).trimIn).toBeCloseTo((10 / 150) * 100, 5)
  })

  test('falls back to the old arithmetic for a clip with no window', () => {
    const c = clip({ s: 2238, e: 2293, win: null })
    expect(windowFor(c)).toEqual({ start: 2208, span: 150 })
  })
})

describe('EditorScreen job state', () => {
  test('saving is available on a finished project', () => {
    const markup = html(clip())
    expect(markup).toContain('Save as new clip')
    expect(markup).not.toContain('still processing')
  })

  test('shows the progress banner and blocks saving while the job runs', () => {
    // The refusal used to arrive as a toast naming a job the screen displayed
    // nowhere, because the editor renders outside the shell that carries the
    // indicator.
    // Every ratio rendered, so the only disabled controls can be the header
    // buttons -- the crop buttons disable themselves for missing renders.
    const all = clip({
      renders: {
        '9:16': render(),
        '1:1': render({ ratio: '1:1' }),
        '4:5': render({ ratio: '4:5' }),
      },
    })
    const ready = html(all)
    expect(ready).not.toContain('disabled=""')

    const running = html(all, { jobStatus: 'rendering', stage: 'Rendering 3 of 12', progress: 62 })
    expect(running).toContain('still processing')
    expect(running).toContain('Rendering 3 of 12')
    expect(running).toContain('disabled=""')
  })

  test('explains a failed project rather than inviting a save that cannot work', () => {
    const markup = html(clip(), { jobStatus: 'failed', progress: 20 })
    expect(markup).toContain('failed')
    expect(markup).toContain('Regenerate it to try again')
  })
})
