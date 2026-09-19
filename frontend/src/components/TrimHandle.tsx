import type { PointerEvent as ReactPointerEvent } from 'react'

/**
 * A draggable in/out marker. Arrow keys move it too, so the window can be set
 * without a pointer.
 */
export function TrimHandle({
  which,
  value,
  onPointerDown,
  onNudge,
}: {
  which: 'in' | 'out'
  value: number
  onPointerDown: (e: ReactPointerEvent) => void
  onNudge: (delta: number) => void
}) {
  return (
    <button
      type="button"
      role="slider"
      aria-label={which === 'in' ? 'Clip start' : 'Clip end'}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
      aria-valuetext={`${Math.round(value)}% along the visible timeline`}
      onPointerDown={onPointerDown}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') {
          e.preventDefault()
          onNudge(-1)
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault()
          onNudge(1)
        }
      }}
      style={{ left: `${value}%` }}
      className="absolute top-1/2 h-[46px] w-[11px] -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-[5px] border border-white/35 bg-violet"
    />
  )
}
