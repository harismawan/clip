/**
 * The recommendation panel: what it shows, and what it refuses to show.
 *
 * The flag cases matter most. The server 404s these routes when the feature is
 * off, so a panel that rendered anyway would sit there making requests that
 * cannot succeed -- and the flag can flip under a tab that is already open.
 */
import { test, expect, describe } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { RecommendationPanel } from './RecommendationPanel'
import { AppContext } from '../state/AppContext'
import type { Snipline } from '../state/useSnipline'
import type { Recommendation, RecommendationRound } from '../types'

const rec = (idx: number, over: Partial<Recommendation> = {}): Recommendation => ({
  idx,
  title: `Moment ${idx}`,
  start: 100 + idx * 60,
  end: 140 + idx * 60,
  score: 80,
  snippet: `snippet ${idx}`,
  caption: 'caption',
  line: 'line',
  taken: false,
  ...over,
})

const round = (over: Partial<RecommendationRound> = {}): RecommendationRound => ({
  id: 'r1',
  message: null,
  candidates: [rec(0), rec(1)],
  createdAt: '2026-09-23T00:00:00.000Z',
  ...over,
})

interface Opts {
  on?: boolean
  recs?: RecommendationRound[]
  picked?: number[]
  asking?: boolean
  error?: string | null
}

const html = ({ on = true, recs = [round()], picked = [], asking = false, error = null }: Opts) => {
  const stub = {
    state: {
      jobId: 'j1',
      recs,
      recsPicked: picked,
      recsLoading: false,
      recsAsking: asking,
      recsCreating: false,
      recsError: error,
      user: {
        id: 'u1',
        email: 'a@b.c',
        name: null,
        pictureUrl: null,
        features: { editor: false, recommendations: on },
      },
    },
    loadRecommendations: () => {},
    askRecommendations: () => {},
    toggleRecommendation: () => {},
    createFromRecommendations: () => {},
  } as unknown as Snipline

  return renderToStaticMarkup(
    <AppContext.Provider value={stub}>
      <RecommendationPanel />
    </AppContext.Provider>,
  )
}

const count = (s: string, needle: string) => s.split(needle).length - 1

describe('the flag', () => {
  test('renders nothing at all when recommendations are off', () => {
    expect(html({ on: false })).toBe('')
  })

  test('renders the list when they are on', () => {
    expect(html({})).toContain('More moments we found')
  })

  /**
   * A project from before the feature has no opening round, and its video may
   * have no transcript either -- so the chat box would be a button that 409s.
   */
  test('renders nothing for a project with no rounds', () => {
    expect(html({ recs: [] })).toBe('')
  })
})

describe('the list', () => {
  test('shows each moment with its range', () => {
    const s = html({})
    expect(s).toContain('Moment 0')
    expect(s).toContain('Moment 1')
    expect(s).toContain('1:40')
  })

  test('offers a checkbox per moment for the batch path', () => {
    expect(count(html({}), 'type="checkbox"')).toBe(2)
  })

  /**
   * A moment an existing clip already covers is shown, not hidden -- removing
   * rows on creation would make the list jump under the pointer -- but it
   * cannot be picked again.
   */
  test('disables a moment that is already clipped', () => {
    const taken = html({ recs: [round({ candidates: [rec(0, { taken: true })] })] })
    const free = html({ recs: [round({ candidates: [rec(0)] })] })

    expect(taken).toContain('already clipped')
    // Measured as a delta against the same row untaken, because the Ask button
    // is disabled in both (the draft is empty) and would otherwise be counted.
    expect(count(taken, 'disabled=""') - count(free, 'disabled=""')).toBe(2)
  })

  test('says so when a round came back with nothing new', () => {
    const s = html({ recs: [round({ candidates: [] })] })
    expect(s).toContain('Nothing new')
  })
})

describe('the chat', () => {
  test('shows what was asked, but draws no bubble for the opening round', () => {
    const s = html({
      recs: [round(), round({ id: 'r2', message: 'more about funding' })],
    })
    expect(s).toContain('more about funding')
    expect(count(s, 'rounded-[9px] bg-black/[0.055]')).toBe(1)
  })

  test('lists only the newest round, older ones being history', () => {
    const s = html({
      recs: [
        round({ candidates: [rec(0, { title: 'Old moment' })] }),
        round({ id: 'r2', message: 'again', candidates: [rec(0, { title: 'New moment' })] }),
      ],
    })
    expect(s).toContain('New moment')
    expect(s).not.toContain('Old moment')
  })

  /** Five to fifteen seconds of waiting needs to look like waiting. */
  test('says it is thinking while a turn is in flight', () => {
    expect(html({ asking: true })).toContain('Thinking…')
  })

  test('shows a refusal next to the box rather than losing it to a toast', () => {
    expect(html({ error: 'Storage full.' })).toContain('Storage full.')
  })
})

describe('the batch button', () => {
  test('stays away until something is picked', () => {
    expect(html({})).not.toContain('Create ')
  })

  test('counts what is picked, in the singular when it is one', () => {
    expect(html({ picked: [0] })).toContain('Create 1 clip')
    expect(html({ picked: [0, 1] })).toContain('Create 2 clips')
  })
})
