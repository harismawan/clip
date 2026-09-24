/**
 * The front page. Rendered to static markup, so this checks what a visitor is
 * shown and where it leads, not the click handling.
 */
import { test, expect, describe } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { LandingScreen } from './LandingScreen'
import { LoginScreen } from './LoginScreen'
import { AppContext } from '../state/AppContext'
import type { Snipline } from '../state/useSnipline'

const stub = { state: { pending: null }, goLogin() {}, goLanding() {}, signIn() {} } as unknown as Snipline
const render = (el: React.ReactElement) =>
  renderToStaticMarkup(<AppContext.Provider value={stub}>{el}</AppContext.Provider>)

describe('LandingScreen', () => {
  const html = render(<LandingScreen />)

  test('has exactly one page heading, and it says what the product does', () => {
    expect(html.match(/<h1/g)).toHaveLength(1)
    expect(html).toContain('Turn one long video into a week of posts.')
  })

  /** Real links, so open-in-new-tab and copy-link work on every call to action. */
  test('every sign-up and log-in control is a link to /login', () => {
    const toLogin = html.match(/<a href="\/login"/g) ?? []
    expect(toLogin.length).toBeGreaterThanOrEqual(3) // header x2, hero, closing
    expect(html).toContain('>Log in<')
    expect(html).toContain('Get started free')
  })

  test('the secondary call to action stays on the page', () => {
    expect(html).toContain('href="#how"')
    expect(html).toContain('id="how"')
  })

  /**
   * A public page must not carry invented social proof, nor advertise the
   * editor while it is switched off.
   */
  test('no testimonials, no placeholders, no editor', () => {
    expect(html.toLowerCase()).not.toContain('testimonial')
    expect(html.toLowerCase()).not.toContain('placeholder')
    expect(html).not.toMatch(/\btrim\b|\beditor\b/i)
  })

  test('carries the clip2 name', () => {
    expect(html).toContain('clip2')
  })
})

describe('LoginScreen', () => {
  test('its logo leads back to the front page', () => {
    // LoginScreen reads ?error= from the address bar as it renders.
    const had = 'window' in globalThis
    Object.assign(globalThis, { window: { location: { search: '' } } })
    const html = render(<LoginScreen />)
    if (!had) delete (globalThis as { window?: unknown }).window
    expect(html).toContain('href="/"')
    expect(html).toContain('aria-label="clip2 home"')
  })
})
