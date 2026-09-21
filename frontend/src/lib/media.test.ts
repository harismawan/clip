/**
 * The breakpoint predicate behind the editor's desktop gate.
 *
 * A CSS-only gate would still mount the whole editor on a phone and could not be
 * asserted on, so the decision is made in JS. matchMedia is injected because
 * bun:test has no window.
 */
import { test, expect, describe } from 'bun:test'
import { DESKTOP_QUERY, matchesDesktop } from './media'

/** A stand-in for window.matchMedia that reports a fixed viewport width. */
const windowOfWidth = (px: number) =>
  ({
    matchMedia: (query: string) => ({
      // Only understands the one query this module uses.
      matches: query === DESKTOP_QUERY ? px >= 768 : false,
    }),
  }) as unknown as Window

describe('matchesDesktop', () => {
  test('a phone is not desktop', () => {
    expect(matchesDesktop(windowOfWidth(375))).toBe(false)
    expect(matchesDesktop(windowOfWidth(430))).toBe(false)
  })

  test('the md breakpoint itself counts as desktop', () => {
    // Tailwind's md is min-width:768px, and the gate must agree with the CSS
    // that hides the sidebar, or the two disagree at exactly 768.
    expect(matchesDesktop(windowOfWidth(768))).toBe(true)
  })

  test('a laptop is desktop', () => {
    expect(matchesDesktop(windowOfWidth(1280))).toBe(true)
  })

  test('assumes desktop when matchMedia is unavailable', () => {
    // Server rendering and very old browsers. Guessing "desktop" degrades to
    // the previous behaviour rather than hiding the editor from everyone.
    expect(matchesDesktop(undefined)).toBe(true)
    expect(matchesDesktop({} as unknown as Window)).toBe(true)
  })

  test('the query matches the sidebar breakpoint', () => {
    expect(DESKTOP_QUERY).toBe('(min-width: 768px)')
  })
})
