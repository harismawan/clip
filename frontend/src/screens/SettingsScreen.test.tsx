/**
 * The Account card.
 *
 * Sign out used to live only in the sidebar, which is `hidden md:flex`, so
 * below 768px there was no way to sign out of the app at all. Settings is
 * reachable at every width, which is why it belongs here rather than as a
 * mobile-only duplicate in MobileNav.
 */
import { test, expect, describe } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SettingsScreen } from './SettingsScreen'
import { AppContext } from '../state/AppContext'
import type { Snipline } from '../state/useSnipline'
import type { Me } from '../lib/api'

const me = (over: Partial<Me> = {}): Me => ({
  id: 'u1',
  email: 'wildan@example.com',
  name: 'Wildan A',
  pictureUrl: 'https://lh3.example/photo.jpg',
  // Settings has nothing to do with the editor; the flag just has to be set.
  features: { editor: false, recommendations: false },
  ...over,
})

const html = (user: Me | null, pending: string | null = null) => {
  const stub = {
    state: {
      user,
      pending,
      lengthIdx: 1,
      formats: { '9:16': true, '1:1': false, '4:5': false },
      subs: true,
      emailMe: true,
      pwCurrent: '',
      pwNext: '',
    },
    cycleLength: () => {},
    toggleFormat: () => {},
    toggleSubs: () => {},
    toggleEmail: () => {},
    say: () => {},
    setPwCurrent: () => {},
    setPwNext: () => {},
    updatePassword: () => {},
    signOut: () => {},
  } as unknown as Snipline
  return renderToStaticMarkup(
    <AppContext value={stub}>
      <SettingsScreen />
    </AppContext>,
  )
}

describe('Settings account card', () => {
  test('offers a way to sign out', () => {
    expect(html(me())).toContain('Sign out')
  })

  test('shows the signed-in account, not prototype text', () => {
    const markup = html(me())
    expect(markup).toContain('wildan@example.com')
    expect(markup).not.toContain('you@email.com')
    expect(markup).not.toContain('Signed in with a login link')
  })

  test('shows the account name when there is one', () => {
    expect(html(me())).toContain('Wildan A')
  })

  test('falls back to the email when the account has no name', () => {
    // Google does not always return a name; the row must not read "null".
    const markup = html(me({ name: null }))
    expect(markup).toContain('wildan@example.com')
    expect(markup).not.toContain('null')
  })

  test('survives having no avatar', () => {
    const markup = html(me({ pictureUrl: null }))
    expect(markup).not.toContain('src=""')
    expect(markup).toContain('wildan@example.com')
  })

  test('reports progress while signing out', () => {
    expect(html(me(), 'signOut')).toContain('Signing out…')
  })

  test('renders without a resolved session rather than crashing', () => {
    // /api/auth/me can still be in flight on first paint.
    expect(() => html(null)).not.toThrow()
  })
})
