/**
 * Moments the model found but nobody clipped, and the chat that asks for
 * different ones.
 *
 * Sits under the clip grid rather than on a screen of its own: it is a second
 * look at a project that already has results, and a user who is happy with
 * their clips should be able to ignore it by not scrolling.
 *
 * Two ways in, because they answer different questions. Clicking a row is "that
 * one, now" -- the impulse you have while reading it. The checkboxes are for
 * "these three of the eight", where making one clip at a time means waiting for
 * each render before judging the next.
 */
import { useEffect, useState } from 'react'
import { Button } from './Button'
import { Chip } from './Chip'
import { cn } from '../lib/cn'
import { fmt } from '../lib/format'
import { useApp } from '../state/AppContext'
import { MAX_CHAT_CHARS } from '../data/fixtures'

export function RecommendationPanel() {
  const {
    state,
    loadRecommendations,
    askRecommendations,
    toggleRecommendation,
    createFromRecommendations,
  } = useApp()
  const [draft, setDraft] = useState('')

  /**
   * Fetched here rather than alongside the job, because this panel is the only
   * thing that wants it: a project opened and downloaded without scrolling
   * should not have paid for a list nobody looked at.
   *
   * Keyed on the job, so switching projects refetches. Every hook runs before
   * the early returns below -- React requires the same hooks in the same order
   * on every render, and the flag can flip under a live tab.
   */
  const jobId = state.jobId
  useEffect(() => {
    void loadRecommendations()
  }, [jobId, loadRecommendations])

  // Defaults to false: /me may not have answered yet, and a panel that appears
  // and then disappears is worse than one that never appears.
  if (!state.user?.features?.recommendations) return null

  const live = state.recs[state.recs.length - 1]
  const asked = state.recs.filter((r) => r.message !== null)
  const picked = state.recsPicked
  const busy = state.recsAsking || state.recsCreating

  const send = () => {
    const text = draft.trim()
    if (!text || busy) return
    setDraft('')
    void askRecommendations(text)
  }

  /**
   * Nothing to show and nothing asked yet. The analyse stage produces the
   * opening round, so an empty list means this project predates the feature --
   * offering a chat box against a transcript that may not exist would be a
   * button that 409s.
   */
  if (!live && !state.recsLoading && asked.length === 0) return null

  return (
    <section className="mt-6 max-w-[1120px] border-t border-black/8 pt-5">
      <h2 className="m-0 mb-1 text-[13.5px] font-semibold text-ink">More moments we found</h2>
      <p className="m-0 mb-3.5 text-[11.5px] text-black/45">
        Already checked against your clips. Pick any to render them into this project.
      </p>

      {state.recsLoading && <p className="m-0 text-[12px] text-black/42">Loading…</p>}

      {/*
        The conversation so far. The opening round has no message -- nobody
        asked for it -- so it contributes no bubble, which is what `message:
        null` is for on the wire.
      */}
      {asked.length > 0 && (
        <ul className="m-0 mb-3.5 flex list-none flex-col gap-1.5 p-0">
          {asked.map((r) => (
            <li
              key={r.id}
              className="self-end rounded-[9px] bg-black/[0.055] px-2.5 py-1.5 text-[12px] text-ink"
            >
              {r.message}
            </li>
          ))}
        </ul>
      )}

      {live && live.candidates.length === 0 && (
        <p className="m-0 mb-3.5 text-[12px] text-black/42">
          Nothing new that does not overlap what you already have. Try asking for something
          different.
        </p>
      )}

      {live && live.candidates.length > 0 && (
        <ul className="m-0 mb-3.5 flex list-none flex-col gap-1.5 p-0">
          {live.candidates.map((rec) => {
            const on = picked.includes(rec.idx)
            return (
              <li key={rec.idx}>
                <div
                  className={cn(
                    'flex items-start gap-2.5 rounded-[9px] border-[1.5px] px-2.5 py-2',
                    rec.taken ? 'border-black/8 opacity-55' : 'border-black/12',
                    on && 'border-ink/35 bg-black/[0.03]',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={rec.taken || busy}
                    onChange={() => toggleRecommendation(rec.idx)}
                    aria-label={`Select ${rec.title}`}
                    className="mt-[3px] h-4 w-4 flex-none accent-ink"
                  />
                  {/*
                    The row body is the one-click path. A button, not a div with
                    a handler: it is reachable by keyboard and announces itself,
                    and the checkbox beside it stays separately operable.
                  */}
                  <button
                    type="button"
                    disabled={rec.taken || busy}
                    onClick={() => void createFromRecommendations([rec.idx])}
                    className="min-w-0 flex-1 cursor-pointer border-0 bg-transparent p-0 text-left disabled:cursor-default"
                  >
                    <span className="block text-[12.5px] leading-[1.35] font-semibold text-ink">
                      {rec.title}
                    </span>
                    <span className="mt-[3px] block text-[11px] text-black/42">
                      {fmt(rec.start)} → {fmt(rec.end)}
                      {rec.taken && ' · already clipped'}
                    </span>
                    {rec.snippet && (
                      <span className="mt-[5px] line-clamp-2 block text-[11px] leading-[1.45] text-muted">
                        {rec.snippet}
                      </span>
                    )}
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {picked.length > 0 && (
        <Button
          onClick={() => void createFromRecommendations(picked)}
          disabled={busy}
          className="mb-3.5 h-10 px-4 text-[13px]"
        >
          {state.recsCreating
            ? 'Creating…'
            : `Create ${picked.length} ${picked.length === 1 ? 'clip' : 'clips'}`}
        </Button>
      )}

      <div className="flex items-start gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send()
          }}
          maxLength={MAX_CHAT_CHARS}
          disabled={busy}
          placeholder="Ask for other moments, e.g. only the parts about pricing"
          aria-label="Ask for other moments"
          className="h-10 min-w-0 flex-1 rounded-[9px] border-[1.5px] border-black/14 px-2.5 text-[12.5px] text-ink outline-none focus:border-ink/35 disabled:bg-black/[0.03]"
        />
        <Chip onClick={send} disabled={busy || !draft.trim()} className="h-10 px-3.5">
          {state.recsAsking ? 'Thinking…' : 'Ask'}
        </Chip>
      </div>

      {/*
        Beside the box it came from, not in a toast. A quota refusal or a 503 is
        something to read and act on, and a toast is gone in 2.6 seconds.
      */}
      {state.recsError && (
        <p className="m-0 mt-2 text-[11.5px] text-red-600">{state.recsError}</p>
      )}
    </section>
  )
}
