/**
 * The editor's stand-in on small screens.
 *
 * The editor packs ~487px of non-shrinking header controls into a 335px phone
 * viewport, so its primary action is clipped off-screen and untappable. It is
 * also still the fixtures-backed prototype, so the honest move is to say so and
 * offer a way back rather than ship a broken screen.
 *
 * Props, not context, so it renders to static markup without a provider.
 */
import { test, expect, describe } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { EditorUnavailable } from './EditorUnavailable'

const html = (title?: string) =>
  renderToStaticMarkup(<EditorUnavailable clipTitle={title} onBack={() => {}} />)

describe('EditorUnavailable', () => {
  test('explains why the editor is not shown', () => {
    const markup = html()
    expect(markup).toContain('bigger screen')
  })

  test('always offers a way back to the clips', () => {
    // Without this the screen is a dead end -- there is no nav chrome here,
    // because the editor renders outside AppShell.
    expect(html()).toContain('Back to clips')
  })

  test('names the clip you tried to edit, when known', () => {
    expect(html('The pricing mistake')).toContain('The pricing mistake')
  })

  test('reads sensibly when the clip has no title', () => {
    const markup = html()
    expect(markup).not.toContain('undefined')
    expect(markup).not.toContain('null')
  })
})
