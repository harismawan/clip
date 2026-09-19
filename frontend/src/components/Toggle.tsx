import { cn } from '../lib/cn'

/** Presentational switch. The whole surrounding row is the click target. */
export function Toggle({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={cn(
        'flex h-5 w-[34px] flex-none rounded-[10px] p-0.5 transition-colors',
        on ? 'justify-end bg-violet' : 'justify-start bg-track',
      )}
    >
      <span className="size-4 rounded-full bg-white" />
    </span>
  )
}
