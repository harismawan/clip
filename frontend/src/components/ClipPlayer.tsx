import { useEffect, useRef } from 'react'
import { fmt } from '../lib/format'
import type { Clip, Ratio } from '../types'

/**
 * Watch one rendered clip, over the grid.
 *
 * An overlay rather than a screen: the editor already owns "open one clip" as a
 * full screen, but that is the prototype timeline, and watching a finished
 * render should not cost you your place in the results grid.
 *
 * Props, not context, so it renders to static markup in a test without a
 * provider -- the same reason JobIndicator takes props.
 */
export function ClipPlayer({
  clip,
  ratio,
  onClose,
}: {
  clip: Clip | null
  ratio: Ratio
  onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)

  // Escape closes, matching the editor screen's keyboard contract.
  useEffect(() => {
    if (!clip) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [clip, onClose])

  // Move focus into the overlay so the keyboard is not left behind the backdrop.
  useEffect(() => {
    if (clip) closeRef.current?.focus()
  }, [clip])

  if (!clip) return null

  const url = clip.renders[ratio]?.url ?? null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Playing ${clip.t}`}
      className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-black/78 p-6"
      // A click on the backdrop itself closes; clicks inside must not bubble out.
      onClick={onClose}
    >
      <div
        className="flex max-h-full min-h-0 flex-col items-center gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        {url ? (
          <video
            src={url}
            controls
            autoPlay
            playsInline
            className="min-h-0 max-w-full rounded-[14px] bg-black shadow-2xl"
            style={{ maxHeight: '72vh' }}
          />
        ) : (
          <div className="rounded-[14px] bg-white px-6 py-8 text-[13px] text-muted">
            That format is not ready for this clip yet.
          </div>
        )}

        <div className="max-w-[560px] text-center">
          <div className="text-[13.5px] font-semibold text-white">{clip.t}</div>
          <div className="mt-0.5 text-[11.5px] text-white/60">
            {fmt(clip.e - clip.s)} · {ratio}
          </div>
        </div>
      </div>

      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        aria-label="Close player"
        className="absolute top-4 right-5 cursor-pointer rounded-[8px] px-2.5 py-1 text-[20px] leading-none text-white/75 hover:bg-white/10 hover:text-white"
      >
        ×
      </button>
    </div>
  )
}
