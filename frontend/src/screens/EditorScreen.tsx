import { useEffect } from 'react'
import { Button } from '../components/Button'
import { Chip } from '../components/Chip'
import { EditorUnavailable } from '../components/EditorUnavailable'
import { TrimHandle } from '../components/TrimHandle'
import { FEATURES } from '../config'
import { CLIPS, WAVE } from '../data/fixtures'
import { cn } from '../lib/cn'
import { clipTitle } from '../lib/derive'
import { fmt } from '../lib/format'
import { useIsDesktop } from '../lib/media'
import { useApp } from '../state/AppContext'
import { windowFor } from '../state/useSnipline'
import type { Clip } from '../types'

const CROPS = [
  { value: '9/16', label: '9:16', box: 'w-[52px] h-[92px]' },
  { value: '1/1', label: '1:1', box: 'w-[52px] h-[52px]' },
  { value: '4/5', label: '4:5', box: 'w-[52px] h-[65px]' },
]

const FILMSTRIP_FRAMES = 16
const TICKS = 6
/** Seconds each nudge moves an in/out point. */
const NUDGE_SECONDS = 1

export function EditorScreen() {
  const isDesktop = useIsDesktop()
  const {
    state,
    trackRef,
    say,
    backToResults,
    saveAndDownload,
    setRatio,
    rewriteCaption,
    setTrim,
    markTrim,
    beginDrag,
    pickRange,
    resetTrim,
    togglePlay,
  } = useApp()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return
      if (e.key === ' ') {
        e.preventDefault()
        togglePlay()
      } else if (e.key === 'i' || e.key === 'I') {
        markTrim('in')
      } else if (e.key === 'o' || e.key === 'O') {
        markTrim('out')
      } else if (e.key === 'Escape') {
        backToResults()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [backToResults, markTrim, togglePlay])

  /**
   * Below `md` the editor is replaced wholesale rather than reflowed.
   *
   * Its header alone packs ~487px of non-shrinking, nowrap controls into a
   * 335px viewport, which clips "Save & download" off-screen with no way to
   * reach it. Every hook above runs first, so this early return cannot change
   * hook order.
   */
  if (!isDesktop) {
    return (
      <EditorUnavailable
        clipTitle={state.clips.find((c) => c.id === state.editing)?.t}
        onBack={backToResults}
      />
    )
  }

  // The editor is still a prototype (Tier A defers it), so it falls back to
  // fixture data when opened without a real clip in hand.
  const clip: Clip = state.clips.find((c) => c.id === state.editing) ?? {
    ...CLIPS[0],
    id: 'prototype',
    idx: 0,
    status: 'ready',
    renders: {},
    selected: false,
  }
  const win = windowFor(clip)
  const inSec = win.start + (win.span * state.trimIn) / 100
  const outSec = win.start + (win.span * state.trimOut) / 100
  const nudgeStep = (NUDGE_SECONDS / win.span) * 100

  /** Position on the visible timeline, as a percentage, for a source offset. */
  const pctAt = (offset: number) => ((clip.s + offset - win.start) / win.span) * 100

  const transcript = [
    { ts: fmt(clip.s - 6), text: 'and then I ran it against prod by accident', from: -6, to: 0 },
    { ts: fmt(clip.s), text: clip.sn.replace(/^…|…$/g, ''), from: 0, to: 24 },
    {
      ts: fmt(clip.s + 24),
      text: 'and honestly my first thought was, well, that’s the product gone',
      from: 24,
      to: clip.e - clip.s,
    },
    {
      ts: fmt(clip.e),
      text: 'anyway, back up your stuff. that’s the whole lesson',
      from: clip.e - clip.s,
      to: clip.e - clip.s + 18,
    },
  ]

  const playheadLeft = Math.max(state.trimIn, Math.min(state.trimOut, state.playhead))

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-night">
      <header className="flex h-[54px] flex-none items-center gap-3.5 border-b border-white/10 px-5">
        <button
          type="button"
          onClick={backToResults}
          className="flex-none cursor-pointer text-[12.5px] font-medium text-white/55 hover:text-white"
        >
          ← Back to clips
        </button>
        <h1 className="m-0 truncate text-[13.5px] font-semibold text-white">
          Clip · {clipTitle(clip)}
        </h1>
        {FEATURES.showHookScore && (
          <span className="flex-none rounded-[5px] bg-white/14 px-[7px] py-[3px] text-[10.5px] font-semibold whitespace-nowrap text-white">
            {clip.sc} hook
          </span>
        )}
        <div className="ml-auto flex flex-none gap-2.5">
          <Button
            variant="onDark"
            onClick={() => say('Recutting this clip…')}
            className="h-9 px-[15px] text-[12.5px]"
          >
            Regenerate this clip
          </Button>
          <Button onClick={saveAndDownload} className="h-9 px-[18px] text-[12.5px]">
            Save &amp; download
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-w-0 flex-1 items-center justify-center gap-[22px] p-[22px]">
          <div
            className="hatch-night-lg relative flex h-full max-h-[420px] flex-col justify-end rounded-xl border-2 border-dashed border-violet/55 p-[18px]"
            style={{ aspectRatio: state.ratio }}
          >
            {state.playing && (
              <span className="absolute top-3.5 left-3.5 rounded-[5px] bg-violet/85 px-[7px] py-[3px] text-[10.5px] font-semibold text-white">
                playing
              </span>
            )}
            <p className="m-0 text-center text-[17px] leading-[1.25] font-bold whitespace-pre-line text-white [text-shadow:0_2px_6px_rgba(0,0,0,.6)]">
              {clip.line}
            </p>
          </div>

          <fieldset className="m-0 flex flex-none flex-col gap-2.5 border-0 p-0">
            <legend className="p-0 text-[10.5px] font-semibold tracking-[.07em] text-white/40 uppercase">
              Crop
            </legend>
            {CROPS.map((crop) => {
              const on = state.ratio === crop.value
              return (
                <button
                  key={crop.value}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setRatio(crop.value)}
                  className={cn(
                    'flex cursor-pointer items-center justify-center rounded-[7px] border-[1.5px] text-[11px] font-semibold transition-colors',
                    crop.box,
                    on
                      ? 'border-violet bg-violet/16 text-white'
                      : 'border-white/18 bg-transparent text-white/60 hover:border-white/40',
                  )}
                >
                  {crop.label}
                </button>
              )
            })}
          </fieldset>
        </div>

        <aside className="flex w-full flex-none flex-col gap-[18px] overflow-auto border-white/10 bg-night-panel p-5 lg:w-[322px] lg:border-l">
          <section>
            <h2 className="m-0 mb-2.5 text-[10.5px] font-semibold tracking-[.07em] text-white/40 uppercase">
              Transcript — click a line to trim to it
            </h2>
            <div className="flex flex-col gap-0.5">
              {transcript.map((line) => {
                const a = pctAt(line.from)
                const b = pctAt(line.to)
                const inRange = state.trimIn <= a + 0.5 && b <= state.trimOut + 0.5
                return (
                  <button
                    key={line.ts + line.text}
                    type="button"
                    onClick={() => pickRange(a, b)}
                    className={cn(
                      'flex cursor-pointer gap-2.5 rounded-[7px] px-[9px] py-[7px] text-left text-[12.5px] leading-[1.5] transition-colors',
                      inRange ? 'bg-violet/18 text-white' : 'text-white/35 hover:bg-white/5',
                    )}
                  >
                    <span
                      className={cn(
                        'flex-none tabular-nums',
                        inRange ? 'text-night-lilac' : 'text-white/30',
                      )}
                    >
                      {line.ts}
                    </span>
                    <span>{line.text}</span>
                  </button>
                )
              })}
            </div>
          </section>

          <section>
            <h2 className="m-0 mb-2.5 text-[10.5px] font-semibold tracking-[.07em] text-white/40 uppercase">
              Caption for posting
            </h2>
            <p className="m-0 rounded-[8px] border border-white/14 p-[11px] text-[12.5px] leading-[1.55] text-white/80">
              {state.captionIdx === 0 ? clip.cap : `Rewritten: ${clip.cap.toLowerCase()}`}
              <br />
              <span className="text-night-lilac">
                #buildinpublic #sidehustle #creatoreconomy
              </span>
            </p>
            <div className="mt-2 flex gap-2">
              <Chip onDark onClick={rewriteCaption} className="h-[30px] px-[11px]">
                Rewrite
              </Chip>
              <Chip onDark onClick={() => say('Caption copied.')} className="h-[30px] px-[11px]">
                Copy
              </Chip>
            </div>
          </section>

          <p className="m-0 mt-auto rounded-[8px] bg-white/5 p-[11px] text-[11.5px] leading-[1.55] text-white/50">
            Drag the violet handles, or nudge the in/out points below.
            <br />
            <span className="text-white/70">space</span> play ·{' '}
            <span className="text-white/70">i</span> /{' '}
            <span className="text-white/70">o</span> set in/out at the playhead ·{' '}
            <span className="text-white/70">esc</span> back
          </p>
        </aside>
      </div>

      <div className="flex h-[170px] flex-none flex-col gap-[11px] border-t border-white/10 px-5 py-3.5">
        <div className="flex flex-wrap items-center gap-3.5">
          <button
            type="button"
            onClick={togglePlay}
            aria-label={state.playing ? 'Pause preview' : 'Play preview'}
            className="flex size-8 flex-none cursor-pointer items-center justify-center rounded-full bg-white text-[11px] text-ink"
          >
            {state.playing ? '❚❚' : '▶'}
          </button>
          <span className="text-[13px] font-medium tabular-nums text-white">
            {fmt(inSec)} → {fmt(outSec)}
          </span>
          <span className="text-[12.5px] text-white/45">
            {(outSec - inSec).toFixed(1)}s selected
          </span>

          <div className="ml-2 flex gap-1.5">
            <Chip onDark onClick={() => setTrim('in', state.trimIn - nudgeStep)} className="h-7 px-[9px]">
              in −1s
            </Chip>
            <Chip onDark onClick={() => setTrim('in', state.trimIn + nudgeStep)} className="h-7 px-[9px]">
              in +1s
            </Chip>
            <Chip onDark onClick={() => setTrim('out', state.trimOut - nudgeStep)} className="h-7 px-[9px]">
              out −1s
            </Chip>
            <Chip onDark onClick={() => setTrim('out', state.trimOut + nudgeStep)} className="h-7 px-[9px]">
              out +1s
            </Chip>
          </div>

          <Chip onDark onClick={resetTrim} className="ml-auto h-7 px-[11px]">
            Reset to auto
          </Chip>
        </div>

        <div ref={trackRef} className="relative h-[84px] touch-none">
          <div className="absolute inset-0 flex gap-px overflow-hidden rounded-[8px] opacity-50">
            {Array.from({ length: FILMSTRIP_FRAMES }, (_, i) => (
              <div key={i} className="hatch-night flex-1" />
            ))}
          </div>

          <div className="absolute right-0 bottom-2 left-0 flex h-8 items-end gap-0.5 px-0.5 opacity-55">
            {WAVE.map((h, i) => (
              <div key={i} className="flex-1 rounded-[1px] bg-muted" style={{ height: `${h}%` }} />
            ))}
          </div>

          <div
            className="absolute top-0 bottom-0 left-0 rounded-l-[8px] bg-[rgba(26,25,23,.72)]"
            style={{ width: `${state.trimIn}%` }}
          />
          <div
            className="absolute top-0 right-0 bottom-0 rounded-r-[8px] bg-[rgba(26,25,23,.72)]"
            style={{ width: `${100 - state.trimOut}%` }}
          />
          <div
            className="absolute top-0 bottom-0 rounded-[8px] border-2 border-violet"
            style={{ left: `${state.trimIn}%`, right: `${100 - state.trimOut}%` }}
          />

          <TrimHandle
            which="in"
            value={state.trimIn}
            onPointerDown={beginDrag('in')}
            onNudge={(d) => setTrim('in', state.trimIn + d * nudgeStep)}
          />
          <TrimHandle
            which="out"
            value={state.trimOut}
            onPointerDown={beginDrag('out')}
            onNudge={(d) => setTrim('out', state.trimOut + d * nudgeStep)}
          />

          <div
            className="absolute -top-1 -bottom-1 w-0.5 bg-white"
            style={{ left: `${playheadLeft}%` }}
          />
        </div>

        <div className="flex justify-between text-[10.5px] tabular-nums text-white/35">
          {Array.from({ length: TICKS }, (_, i) => (
            <span key={i}>{fmt(win.start + (win.span * i) / (TICKS - 1))}</span>
          ))}
        </div>
      </div>
    </div>
  )
}
