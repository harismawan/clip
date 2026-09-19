import { cn } from '../lib/cn'
import { quota } from '../lib/derive'
import { useApp } from '../state/AppContext'
import type { Screen } from '../types'
import { Button } from './Button'
import { Logo } from './Logo'
import { Meter } from './Meter'

const NAV: Array<{ label: string; screen: Screen }> = [
  { label: 'Projects', screen: 'projects' },
  { label: 'Latest clips', screen: 'results' },
  { label: 'Plan & limits', screen: 'plan' },
  { label: 'Settings', screen: 'settings' },
]

export function Sidebar() {
  const { state, goNew, go, goResults, signOut } = useApp()
  const { label, width } = quota(state.videosUsed)

  return (
    <nav className="hidden w-[212px] flex-none flex-col border-r border-black/8 bg-white px-3.5 py-[18px] md:flex">
      <div className="px-1.5 pb-[18px]">
        <Logo size="sm" />
      </div>

      <Button onClick={goNew} className="mb-4 h-[38px] text-[13px]">
        + New video
      </Button>

      <div className="flex flex-col gap-0.5">
        {NAV.map((item) => {
          const active = state.screen === item.screen
          return (
            <button
              key={item.screen}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => (item.screen === 'results' ? goResults() : go(item.screen))}
              className={cn(
                'flex h-[34px] cursor-pointer items-center rounded-[8px] px-2.5 text-left text-[13px] font-medium transition-colors',
                active ? 'bg-cream text-ink' : 'text-muted hover:bg-cream/70',
              )}
            >
              {item.label}
            </button>
          )
        })}
      </div>

      <div className="mt-auto rounded-[9px] bg-cream p-3">
        <div className="mb-1.5 text-[12px] font-medium text-ink">{label}</div>
        <Meter value={width} className="mb-2 h-1 rounded-[2px]" />
        <p className="m-0 text-[11.5px] leading-[1.45] text-black/45">
          Resets 1 Oct. Clips stay for 30 days.
        </p>
      </div>

      <button
        type="button"
        onClick={signOut}
        className="mt-2.5 cursor-pointer px-1.5 text-left text-[11.5px] font-medium text-black/40 hover:text-ink"
      >
        Sign out
      </button>
    </nav>
  )
}
