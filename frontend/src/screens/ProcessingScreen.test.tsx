/**
 * The tile grid must mirror the clip count the job actually asked for — it used
 * to render a fixed seven tiles regardless.
 */
import { test, expect, describe } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProcessingScreen } from './ProcessingScreen'
import { AppContext } from '../state/AppContext'
import type { Snipline } from '../state/useSnipline'

const html = (count: number, progress: number, jobDone = false) => {
  const stub = {
    state: { count, progress, jobDone, pending: null },
    cancelJob: () => {},
    goResults: () => {},
  } as unknown as Snipline
  return renderToStaticMarkup(
    <AppContext value={stub}>
      <ProcessingScreen />
    </AppContext>,
  )
}

// 'Clip ' (capitalised) only appears on tiles; the header says "clips ready".
const tiles = (markup: string, label: string) => markup.split(label).length - 1

describe('ProcessingScreen', () => {
  test('renders one tile per requested clip, not a fixed seven', () => {
    expect(tiles(html(2, 0), 'Queued')).toBe(1)
    expect(tiles(html(2, 0), 'Rendering…')).toBe(1)
  })

  test('marks tiles ready as progress advances', () => {
    const markup = html(4, 50)
    expect(tiles(markup, 'Clip ')).toBe(2)
    expect(tiles(markup, 'Queued')).toBe(1)
  })

  test('survives a count larger than the prototype duration fixtures', () => {
    expect(() => html(24, 100, true)).not.toThrow()
    expect(tiles(html(24, 100, true), 'Clip ')).toBe(24)
  })
})
