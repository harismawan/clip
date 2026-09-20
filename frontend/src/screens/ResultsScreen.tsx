import { Button } from '../components/Button'
import { Chip } from '../components/Chip'
import { FEATURES } from '../config'
import { RATIOS } from '../data/fixtures'
import { cn } from '../lib/cn'
import { clipAspect, clipTitle, exportLabel, selectedCount, sortClips } from '../lib/derive'
import { fmt } from '../lib/format'
import { useApp } from '../state/AppContext'

export function ResultsScreen() {
  const {
    state,
    regenerateAll,
    setFilter,
    toggleSort,
    toggleClip,
    toggleSelectAll,
    download,
    openEditor,
    redoClip,
  } = useApp()

  const src = state.source
  const ordered = sortClips(state.clips, state.sortByScore)
  const selected = selectedCount(state.clips)
  const allSelected = state.clips.length > 0 && state.clips.every((c) => c.selected)
  const ratio = clipAspect(state.filter)
  // Fall back to all three for a project saved before a format was picked.
  const rendered = RATIOS.filter((r) => state.formats[r])
  const tabs = rendered.length ? rendered : RATIOS

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-start gap-4 px-[26px] pt-5">
        {src?.thumbnailUrl ? (
          <img
            src={src.thumbnailUrl}
            alt=""
            className="w-[104px] flex-none rounded-[7px] object-cover"
            style={{ aspectRatio: '16/9' }}
          />
        ) : (
          <div
            className="hatch-sand w-[104px] flex-none rounded-[7px]"
            style={{ aspectRatio: '16/9' }}
          />
        )}
        <div className="min-w-0 flex-1">
          <h1 className="m-0 mb-1 text-[17px] leading-[1.3] font-semibold text-ink">
            {src?.title ?? 'Your clips'}
          </h1>
          <p className="m-0 text-[12.5px] text-black/45">
            {src ? `${src.platform} · ${src.length} source · ` : ''}
            {state.clips.length} clips
          </p>
        </div>
        <Button
          variant="quiet"
          onClick={regenerateAll}
          loading={state.pending === 'regenerateAll'}
          className="h-9 flex-none px-3.5 text-[12.5px]"
        >
          {state.pending === 'regenerateAll' ? 'Requeueing…' : 'Regenerate all'}
        </Button>
      </div>

      <div className="flex flex-none flex-wrap items-center gap-2.5 px-[26px] pt-[18px] pb-3.5">
        <div className="flex gap-1 rounded-[9px] bg-sand p-[3px]">
          {tabs.map((label) => {
            const on = state.filter === label
            return (
              <button
                key={label}
                type="button"
                aria-pressed={on}
                onClick={() => setFilter(label)}
                className={cn(
                  'flex h-[30px] cursor-pointer items-center rounded-[7px] px-[13px] text-[12.5px] font-semibold transition-colors',
                  on ? 'bg-white text-ink shadow-[0_1px_2px_rgba(0,0,0,.08)]' : 'text-muted',
                )}
              >
                {label}
              </button>
            )
          })}
        </div>

        <Button variant="quiet" onClick={toggleSort} className="h-8 px-[13px] text-[12.5px]">
          {state.sortByScore ? 'Sort: hook score' : 'Sort: time in video'}
        </Button>

        <span className="ml-auto text-[12.5px] text-black/45">{state.clips.length} clips</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-[26px] pb-[22px]">
        <div className="grid max-w-[1120px] grid-cols-[repeat(auto-fill,minmax(min(152px,100%),1fr))] gap-4">
          {ordered.map((clip) => {
            const busy = !!state.regenerating[clip.id]
            const render = clip.renders[state.filter]
            const thumb = render?.thumbUrl ?? null
            return (
              <article
                key={clip.id}
                className={cn(
                  'overflow-hidden rounded-[18px] border-2 bg-white shadow-card transition-colors',
                  clip.selected ? 'border-violet' : 'border-black/10',
                )}
              >
                <button
                  type="button"
                  aria-pressed={clip.selected}
                  aria-label={`${clip.selected ? 'Deselect' : 'Select'} ${clipTitle(clip)}`}
                  onClick={() => toggleClip(clip.id)}
                  className="hatch-clip relative flex w-full cursor-pointer flex-col justify-between p-[9px]"
                  style={{ aspectRatio: ratio }}
                >
                  {/*
                    A real <img> rather than a CSS background, for three reasons:
                    onError can fall back (a background that 404s leaves a blank
                    white card with no hint why), loading="lazy" matters at 24
                    clips, and it gets alt text. The hatch sits underneath, so
                    hiding a broken image reveals the placeholder again.
                  */}
                  {thumb && (
                    <img
                      src={thumb}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      onError={(e) => {
                        e.currentTarget.style.display = 'none'
                      }}
                      className="absolute inset-0 z-0 size-full object-cover"
                    />
                  )}

                  <span className="relative z-10 flex items-start justify-between gap-1.5">
                    {FEATURES.showHookScore && (
                      <span
                        className={cn(
                          '-rotate-3 rounded-full border-[1.5px] border-ink px-2 py-[3px] text-[10.5px] font-bold text-ink',
                          clip.sc >= 80 ? 'bg-lime' : 'bg-[#FFF6E2]',
                        )}
                      >
                        {clip.sc} hook
                      </span>
                    )}
                    <span
                      className={cn(
                        'ml-auto flex size-5 flex-none items-center justify-center rounded-[5px] border-[1.5px] text-[11px] leading-none text-white',
                        clip.selected
                          ? 'border-violet bg-violet'
                          : 'border-white/90 bg-black/12',
                      )}
                    >
                      {clip.selected ? '✓' : ''}
                    </span>
                  </span>
                  <span className="relative z-10 flex justify-end">
                    <span className="rounded-[4px] bg-black/60 px-[5px] py-0.5 text-[10.5px] font-medium text-white">
                      {fmt(clip.e - clip.s)}
                    </span>
                  </span>
                </button>

                <div className="px-[11px] pt-2.5 pb-[11px]">
                  <h2 className="m-0 mb-[5px] text-[12.5px] leading-[1.35] font-semibold text-ink">
                    {busy ? 'Regenerating…' : clipTitle(clip)}
                  </h2>
                  <p className="m-0 mb-[7px] text-[11px] text-black/42">
                    {fmt(clip.s)} → {fmt(clip.e)}
                  </p>
                  {FEATURES.showTranscriptSnippet && (
                    <p className="m-0 mb-[9px] line-clamp-2 text-[11px] leading-[1.45] text-muted">
                      {clip.sn}
                    </p>
                  )}
                  <div className="flex gap-1.5">
                    <Chip onClick={() => openEditor(clip.id)} className="h-[30px] flex-1">
                      Edit
                    </Chip>
                    <Chip
                      onClick={() => redoClip(clip.id)}
                      disabled={busy}
                      className={cn('h-[30px] flex-1', busy && 'text-black/30')}
                    >
                      {busy ? '…' : 'Redo'}
                    </Chip>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      </div>

      <div className="flex h-[66px] flex-none flex-wrap items-center gap-4 border-t border-black/8 bg-white px-[26px]">
        <span className="text-[13.5px] font-semibold text-ink">
          {selected === 0
            ? 'No clips selected'
            : `${selected} ${selected === 1 ? 'clip' : 'clips'} selected`}
        </span>
        <span className="text-[12.5px] text-black/42">{exportLabel(state.filter, state.subs)}</span>
        <div className="ml-auto flex gap-2.5">
          <Button variant="outline" onClick={toggleSelectAll} className="h-10 px-4 text-[13px]">
            {allSelected ? 'Clear selection' : 'Select all'}
          </Button>
          {/*
            A zip of 24 clips outlives the 2.6s toast by a long way, so the
            button carries the wait rather than the toast.
          */}
          <Button
            armed={selected > 0}
            onClick={download}
            loading={state.pending === 'download'}
            className="h-10 px-5 text-[13px]"
          >
            {state.pending === 'download'
              ? selected > 1
                ? 'Zipping…'
                : 'Preparing…'
              : selected
                ? `Download ${selected} ${selected === 1 ? 'clip' : 'clips'}`
                : 'Download'}
          </Button>
        </div>
      </div>
    </div>
  )
}
