import { useEffect, useState } from 'react'

/**
 * Tailwind's `md`. Kept as one constant because the editor's JS gate and the
 * CSS that swaps the sidebar for MobileNav must agree on the same number --
 * if they drift, a viewport exists where you get the mobile nav and the desktop
 * editor at once.
 */
export const DESKTOP_QUERY = '(min-width: 768px)'

/**
 * Whether the viewport is at least `md`.
 *
 * Takes the window so it can be tested, and assumes desktop when matchMedia is
 * missing: guessing wrong that way just restores the old behaviour, whereas
 * guessing "mobile" would hide the editor from everyone.
 */
export function matchesDesktop(win: Window | undefined = globalThis.window): boolean {
  if (!win || typeof win.matchMedia !== 'function') return true
  return win.matchMedia(DESKTOP_QUERY).matches
}

/** `matchesDesktop`, kept current as the viewport changes. */
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(matchesDesktop)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(DESKTOP_QUERY)
    const onChange = () => setIsDesktop(mql.matches)
    // Rotating a phone or dragging a desktop window across the breakpoint must
    // move you between the editor and its stand-in, not strand you on either.
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return isDesktop
}
