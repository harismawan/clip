/**
 * Button's pending state, rendered to static markup.
 *
 * react-dom/server needs no DOM, so this runs under `bun test` with no extra
 * dependency and no test-environment setup.
 *
 * The behaviour worth pinning is not the spinner but the DISABLING: "Get clips"
 * and "Download & make N clips" were clickable throughout their round trip, so a
 * double-click ran an analysis twice or created a second job against a 3-per-day
 * quota.
 */
import { test, expect, describe } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button } from './Button'

const html = (el: React.ReactElement) => renderToStaticMarkup(el)

/**
 * Whether the rendered <button> carries the disabled ATTRIBUTE.
 *
 * Not a substring check: the class list contains Tailwind's
 * `disabled:cursor-not-allowed` variant, so `toContain('disabled')` passes even
 * for a fully clickable button. Three assertions here were green for that reason
 * until an idle-button test caught it.
 */
const isDisabled = (out: string) => /<button[^>]*\sdisabled(=|\s|>)/.test(out)

describe('Button pending state', () => {
  test('a loading button cannot be clicked again', () => {
    expect(isDisabled(html(<Button loading>Get clips</Button>))).toBe(true)
  })

  test('a loading button announces itself to a screen reader', () => {
    expect(html(<Button loading>Get clips</Button>)).toContain('aria-busy="true"')
  })

  test('a loading button shows a spinner', () => {
    expect(html(<Button loading>Get clips</Button>)).toContain('animate-spin')
  })

  test('the spinner is hidden from assistive tech, which reads aria-busy instead', () => {
    const out = html(<Button loading>Get clips</Button>)
    expect(out).toMatch(/aria-hidden="true"[^>]*animate-spin|animate-spin[^>]*aria-hidden="true"/)
  })

  test('the label survives, so the button does not become a mystery', () => {
    expect(html(<Button loading>Get clips</Button>)).toContain('Get clips')
  })

  test('an idle button has no spinner and is clickable', () => {
    const out = html(<Button>Get clips</Button>)
    expect(out).not.toContain('animate-spin')
    expect(isDisabled(out)).toBe(false)
    expect(out).not.toContain('aria-busy')
  })

  test('an explicitly disabled button is dimmed', () => {
    const out = html(<Button disabled>Get clips</Button>)
    expect(isDisabled(out)).toBe(true)
    expect(out).toContain('opacity-55')
  })

  test('a loading button is NOT dimmed as well -- its label stays readable', () => {
    expect(html(<Button loading>Get clips</Button>)).not.toContain('opacity-55')
  })

  test('loading wins over an explicit disabled={false}', () => {
    expect(isDisabled(html(<Button loading disabled={false}>Get clips</Button>))).toBe(true)
  })

  test('only one spinner, even when both flags are set', () => {
    const out = html(<Button loading disabled>Get clips</Button>)
    expect(out.match(/animate-spin/g)).toHaveLength(1)
  })

  test('defaults to type=button, so a button inside a form does not submit it', () => {
    expect(html(<Button>Get clips</Button>)).toContain('type="button"')
  })

  test('an explicit submit type is preserved', () => {
    expect(html(<Button type="submit">Get clips</Button>)).toContain('type="submit"')
  })

  test('the spinner inherits the text colour, so it works on every variant', () => {
    // border-current rather than a fixed colour: onDark buttons have white text.
    expect(html(<Button variant="onDark" loading>Sign out</Button>)).toContain('border-current')
  })
})
