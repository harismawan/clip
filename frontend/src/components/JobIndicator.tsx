import { cn } from '../lib/cn'
import type { JobIndicator as Indicator } from '../lib/derive'
import { Meter } from './Meter'

/**
 * "A video is being processed" — the only way to know from another screen, and
 * the way back to the progress view.
 *
 * Two shapes, one component: `nav` sits in the sidebar and the mobile nav,
 * `banner` spans the top of the shell. Both take the same pre-decided
 * `Indicator` (see jobIndicator in lib/derive.ts), so the sidebar and the banner
 * can never disagree about whether a job is running or what it is called.
 *
 * Props rather than context, so it renders in a test without an app provider.
 */
export function JobIndicator({
  indicator,
  variant,
  onOpen,
  current = false,
}: {
  indicator: Indicator
  variant: 'nav' | 'banner'
  onOpen: () => void
  /** The screen this points at is already showing (nav only). */
  current?: boolean
}) {
  if (!indicator.visible) return null

  const { tone, label, percent } = indicator
  // A finished bar has nothing left to report, and 100% of nothing reads as a
  // stuck job rather than a done one.
  const showBar = tone === 'active'

  if (variant === 'banner') {
    return (
      <div
        aria-live="polite"
        className={cn(
          'flex flex-none items-center gap-3 border-b px-4 py-2.5 md:px-[26px]',
          tone === 'failed'
            ? 'border-[#F0D2D2] bg-[#FDECEC]'
            : tone === 'done'
              ? 'border-lime/50 bg-lime/25'
              : 'border-black/8 bg-white',
        )}
      >
        {tone === 'active' && <Spinner />}
        <span className="min-w-0 truncate text-[12.5px] font-medium text-ink">{label}</span>
        {showBar && (
          <>
            <Meter value={`${percent}%`} tone="violet" className="h-1 w-[90px] flex-none" />
            <span className="flex-none text-[11.5px] tabular-nums text-black/45">{percent}%</span>
          </>
        )}
        <button
          type="button"
          onClick={onOpen}
          className="ml-auto flex h-10 flex-none cursor-pointer items-center rounded-full border-[1.5px] border-ink bg-white px-3.5 text-[12px] font-medium text-ink hover:bg-cream md:h-auto md:px-3 md:py-1"
        >
          {tone === 'done' ? 'See clips' : 'View'}
        </button>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={current ? 'page' : undefined}
      className={cn(
        'mb-0.5 flex w-full cursor-pointer flex-col gap-1 rounded-[8px] px-2.5 py-2 text-left transition-colors',
        current ? 'bg-cream' : 'hover:bg-cream/70',
      )}
    >
      <span className="flex items-center gap-1.5">
        {tone === 'active' && <Spinner />}
        <span
          className={cn(
            'min-w-0 truncate text-[13px] font-medium',
            tone === 'failed' ? 'text-[#8C2F2F]' : 'text-ink',
          )}
        >
          {label}
        </span>
        {showBar && (
          <span className="ml-auto flex-none text-[11px] tabular-nums text-black/45">{percent}%</span>
        )}
      </span>
      {showBar && <Meter value={`${percent}%`} tone="violet" className="h-1" />}
    </button>
  )
}

/** Matches the spinner on a loading Button, so the two read as the same idea. */
function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="block size-3 flex-none animate-spin rounded-full border-2 border-violet border-t-transparent"
    />
  )
}
