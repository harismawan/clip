/**
 * The moments sidebar: what it shows, and what it refuses to show.
 *
 * The flag cases matter most. The server 404s these routes when the feature is
 * off, so a panel that rendered anyway would sit there making requests that
 * cannot succeed -- and the flag can flip under a tab that is already open.
 */
import { test, expect, describe } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MomentsToggle, RecommendationPanel } from './RecommendationPanel'
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
  open?: boolean
  recs?: RecommendationRound[]
  picked?: { roundId: string; indices: number[] } | null
  asking?: boolean
  error?: string | null
}

const stub = ({
  on = true,
  open = true,
  recs = [round()],
  picked = null,
  asking = false,
  error = null,
}: Opts) =>
  ({
    state: {
      jobId: 'j1',
      recs,
      recsPicked: picked,
      recsLoading: false,
      recsAsking: asking,
      recsCreating: false,
      recsError: error,
      recsOpen: open,
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
    toggleRecsOpen: () => {},
    createFromRecommendations: () => {},
  }) as unknown as Snipline

const html = (opts: Opts = {}, el = <RecommendationPanel />) =>
  renderToStaticMarkup(<AppContext.Provider value={stub(opts)}>{el}</AppContext.Provider>)

const count = (s: string, needle: string) => s.split(needle).length - 1

describe('showing and hiding', () => {
  test('renders nothing at all when recommendations are off', () => {
    expect(html({ on: false })).toBe('')
    expect(html({ on: false }, <MomentsToggle />)).toBe('')
  })

  test('renders the sidebar when on and open', () => {
    expect(html()).toContain('aria-label="Moments"')
  })

  test('collapsed: no sidebar, but the toggle stays to bring it back', () => {
    expect(html({ open: false })).toBe('')
    const toggle = html({ open: false }, <MomentsToggle />)
    expect(toggle).toContain('Moments')
    expect(toggle).toContain('aria-expanded="false"')
  })

  /**
   * A project from before the feature has no opening round, and its video may
   * have no transcript either -- so the chat box would be a button that 409s.
   */
  test('renders nothing, toggle included, for a project with no rounds', () => {
    expect(html({ recs: [] })).toBe('')
    expect(html({ recs: [] }, <MomentsToggle />)).toBe('')
  })

  test('the toggle counts what is still on offer, across every reply', () => {
    const recs = [
      round({ candidates: [rec(0), rec(1, { taken: true })] }),
      round({ id: 'r2', message: 'more', candidates: [rec(0), rec(1)] }),
    ]
    expect(html({ recs }, <MomentsToggle />)).toContain('>3<')
  })
})

describe('the conversation', () => {
  test('the opening round is a reply with no question before it', () => {
    const s = html()
    expect(s).toContain('I found 2 moments')
    expect(count(s, 'bg-ink px-3 py-2')).toBe(0) // no user bubble
  })

  test('each ask is a user bubble followed by its reply', () => {
    const s = html({ recs: [round(), round({ id: 'r2', message: 'more about riba' })] })
    expect(s).toContain('more about riba')
    expect(s).toContain('Here are 2 moments for that.')
    expect(s.indexOf('I found')).toBeLessThan(s.indexOf('more about riba'))
    expect(s.indexOf('more about riba')).toBeLessThan(s.indexOf('Here are'))
  })

  /** The old panel listed only the newest round. Every reply stays usable. */
  test('older replies keep their moments on screen', () => {
    const s = html({
      recs: [
        round({ candidates: [rec(0, { title: 'Old moment' })] }),
        round({ id: 'r2', message: 'again', candidates: [rec(0, { title: 'New moment' })] }),
      ],
    })
    expect(s).toContain('Old moment')
    expect(s).toContain('New moment')
  })

  test('says so when a reply came back with nothing new', () => {
    expect(html({ recs: [round({ message: 'x', candidates: [] })] })).toContain('Nothing new')
  })

  /** Five to fifteen seconds of waiting needs to look like waiting. */
  test('shows a thinking bubble while a turn is in flight', () => {
    expect(html({ asking: true })).toContain('Thinking…')
  })

  test('shows a refusal next to the box rather than losing it to a toast', () => {
    expect(html({ error: 'Storage full.' })).toContain('Storage full.')
  })

  test('the box is labelled, and capped at the server limit', () => {
    const s = html()
    expect(s).toContain('aria-label="Ask for other moments"')
    expect(s).toContain('maxLength="280"')
  })
})

describe('picking moments', () => {
  /**
   * Shown greyed, not hidden -- removing it would shift the list under the
   * pointer -- but it cannot be picked a second time.
   */
  test('disables a moment that is already clipped', () => {
    const taken = html({ recs: [round({ candidates: [rec(0, { taken: true })] })] })
    const free = html({ recs: [round({ candidates: [rec(0)] })] })
    expect(taken).toContain('already clipped')
    // A delta, because the Send button is disabled in both (the draft is empty).
    expect(count(taken, 'disabled=""') - count(free, 'disabled=""')).toBe(2)
  })

  test('no create button until something is ticked', () => {
    expect(html()).not.toContain('Create ')
  })

  test('the create button sits under the reply that was ticked, and only there', () => {
    const recs = [round(), round({ id: 'r2', message: 'more' })]
    const s = html({ recs, picked: { roundId: 'r2', indices: [0, 1] } })
    expect(count(s, 'Create 2 clips')).toBe(1)
    expect(s.indexOf('Create 2 clips')).toBeGreaterThan(s.indexOf('more'))
  })

  test('counts in the singular for one', () => {
    expect(html({ picked: { roundId: 'r1', indices: [0] } })).toContain('Create 1 clip<')
  })
})
