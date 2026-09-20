import { Button } from '../components/Button'
import { OptionChip } from '../components/OptionChip'
import { Toggle } from '../components/Toggle'
import { CLIP_COUNTS, COUNT_HINTS, LENGTHS, RATIOS } from '../data/fixtures'
import { cn } from '../lib/cn'
import { useApp } from '../state/AppContext'

export function SetupScreen() {
  const { state, setCount, setLengthIdx, toggleFormat, toggleSubs, startJob, goNew } = useApp()
  const src = state.source

  // Reachable by restoring a stale `screen` from storage without a source.
  if (!src) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-7">
        <button
          type="button"
          onClick={goNew}
          className="cursor-pointer text-[13.5px] font-medium text-violet hover:text-violet-deep"
        >
          No video selected — paste a link to start
        </button>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-7">
      <div className="animate-rise w-full max-w-[640px] overflow-hidden rounded-[22px] border-2 border-ink bg-white shadow-stamp-lg">
        <div className="flex gap-4 border-b border-black/8 p-5">
          <div
            className="hatch-sand flex w-[150px] flex-none items-end justify-end rounded-[8px] p-[7px]"
            style={{ aspectRatio: '16/9' }}
          >
            <span className="rounded-[4px] bg-black/60 px-[5px] py-0.5 text-[10.5px] font-medium text-white">
              {src.length}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 flex items-center gap-[7px]">
              <span className="rounded-[5px] bg-violet/9 px-[7px] py-[3px] text-[10.5px] font-medium tracking-[.05em] text-violet uppercase">
                {src.platform}
              </span>
              <span className="text-[11.5px] text-black/40">Link recognised</span>
            </div>
            <h2 className="m-0 mb-[5px] text-[15px] leading-[1.35] font-semibold text-ink">
              {src.title}
            </h2>
            <p className="m-0 text-[12.5px] text-black/45">{src.meta}</p>
          </div>
        </div>

        <div className="flex flex-col gap-5 px-5 py-[22px]">
          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-[9px] p-0 text-[12.5px] font-medium text-ink">
              How many clips?
            </legend>
            <div className="flex gap-2">
              {CLIP_COUNTS.map((n, i) => {
                const selected = state.count === n
                return (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setCount(n)}
                    className={cn(
                      'flex h-[60px] flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-[9px] border-[1.5px] transition-colors',
                      selected ? 'border-violet bg-violet/5' : 'border-black/14 bg-white hover:bg-cream',
                    )}
                  >
                    <span className="text-[15px] font-semibold text-ink">{n}</span>
                    <span
                      className={cn('text-[11px]', selected ? 'text-violet' : 'text-black/45')}
                    >
                      {COUNT_HINTS[i]}
                    </span>
                  </button>
                )
              })}
            </div>
          </fieldset>

          <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-[18px]">
            <fieldset className="m-0 border-0 p-0">
              <legend className="mb-[9px] p-0 text-[12.5px] font-medium text-ink">
                Clip length
              </legend>
              <div className="flex gap-1.5">
                {LENGTHS.map((label, i) => (
                  <OptionChip
                    key={label}
                    selected={state.lengthIdx === i}
                    onClick={() => setLengthIdx(i)}
                    className="h-9 rounded-[8px]"
                  >
                    {label}
                  </OptionChip>
                ))}
              </div>
            </fieldset>

            <fieldset className="m-0 border-0 p-0">
              <legend className="mb-[9px] p-0 text-[12.5px] font-medium text-ink">
                Formats to render
              </legend>
              <div className="flex gap-1.5">
                {RATIOS.map((label) => (
                  <OptionChip
                    key={label}
                    selected={state.formats[label]}
                    onClick={() => toggleFormat(label)}
                    className="h-9 rounded-[8px]"
                  >
                    {label}
                  </OptionChip>
                ))}
              </div>
            </fieldset>
          </div>

          <button
            type="button"
            onClick={toggleSubs}
            className="flex cursor-pointer items-center gap-2.5 rounded-[9px] bg-cream px-3.5 py-3 text-left"
          >
            <Toggle on={state.subs} label="Burn in subtitles" />
            <span className="min-w-0">
              <span className="block text-[12.5px] font-medium text-ink">Burn in subtitles</span>
              <span className="block text-[11.5px] text-black/45">
                Auto-transcribed, editable per clip later
              </span>
            </span>
          </button>

          <div className="flex flex-wrap items-center gap-3.5">
            <Button
              onClick={startJob}
              loading={state.pending === 'startJob'}
              className="h-[46px] min-w-[220px] flex-1 text-[14px]"
            >
              {state.pending === 'startJob'
                ? 'Queueing…'
                : `Download & make ${state.count} clips`}
            </Button>
            <span className="text-[12px] whitespace-nowrap text-black/42">
              {src.eta} · uses 1 of 3
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
