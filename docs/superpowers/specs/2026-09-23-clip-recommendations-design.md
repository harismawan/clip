# Clip recommendations, with chat refinement

**Status:** accepted
**Date:** 2026-09-23

## The problem

A finished project shows the clips the model picked and nothing else. If the
picks are wrong, the only recourse is `POST /jobs/:id/regenerate`, which wipes
every clip and re-runs the row. That is the wrong shape for "these three are
good, find me more like them": the user has already judged the good ones and
regenerate destroys that judgement.

Worse, the pipeline already *found* more moments than it kept.
`validateRanges` ends with:

```ts
return dropOverlaps(cleaned).slice(0, opts.count)
```

The surplus is fully validated — clamped, snapped to speech boundaries, fitted
to the length window, non-overlapping — and then dropped on the floor. We are
throwing away the exact thing this feature needs to produce.

So: surface the surplus as recommendations, let the user turn any of them into
clips without touching the ones they have, and let them ask the model for a
different set in their own words.

## What is being built

On the results screen, under the clip grid:

- a list of candidate moments — `12:04–12:38 · title · snippet`
- click a row to create that one clip; or tick several and create them together
- a textarea to ask for different moments, which replaces the list
- prior messages stay visible, so the exchange reads as a conversation

Behind a `RECOMMENDATIONS_ENABLED` flag, off-switchable without a rebuild.

## Decisions

### The opening list is free

The first round of recommendations is the surplus from the analyse stage. No
extra model call, no extra latency: the list is already there when the job
finishes.

Capturing it needs no change to `validateRanges`. Its contract — clamp, snap,
fit, drop overlaps, take the best `count` — is worth keeping, so the caller
asks for more and slices twice:

```ts
const ranked  = validateRanges(candidates, { ...opts, count: RECOMMEND_POOL })
const picked  = ranked.slice(0, job.clipCount)   // the clips, exactly as before
const surplus = ranked.slice(job.clipCount)      // the opening recommendations
```

`RECOMMEND_POOL` is generous rather than exact; slicing a short array is not an
error.

One consequence: at `count: 8` the prompt asks for `min(40, ceil(8 × 1.8)) = 15`
candidates, and `dropOverlaps` typically leaves two to five spare. That is a
thin list to open with. When the flag is on the ask rises so the surplus lands
around eight to ten. Extra candidate objects are a rounding error against a
transcript that is already thousands of lines.

### The model call for chat runs in the API, not the worker

`WORKER_CONCURRENCY=1`, because whisper and x264 each want all four cores. A
chat turn queued behind a render waits for the render — minutes at best, most of
an hour for a long source. That is not a conversation.

Recommendations need no CPU and no disk: the transcript is already in Postgres
(`transcripts.segments`, cached per video), so a turn is one HTTP call to
OpenRouter and an insert. It belongs in the API process, where it answers in
five to fifteen seconds and nothing can queue behind a render.

This is why `POST /jobs/:id/recommendations` is synchronous and has no SSE.

### Pure code moves to `shared/`

`worker/src/parse.ts` opens by explaining that it is free of env and I/O imports
because the stage modules validate configuration at import time and exit when it
is missing, which would make the prompt untestable. `worker/src/ranges.ts` says
the same in fewer words: *"Pure functions, no I/O: this is the part of the
pipeline worth unit testing."*

Both were written to be movable, and this is the move:

| New | From | Holds |
| --- | --- | --- |
| `shared/clipPrompt.ts` | `worker/src/parse.ts` | `renderTranscript`, `extractJson`, `fencedUserText`, `buildAnalyzePrompt`, `buildRecommendPrompt` |
| `shared/clipRanges.ts` | `worker/src/ranges.ts` | `Candidate`, `validateRanges`, `textInRange` |
| `shared/openrouter.ts` | `worker/src/stages/analyze.ts` | `CLIP_JSON_SCHEMA`, `requestClips` |

`parseWhisperProgress` stays in `worker/src/parse.ts`: it parses
whisper-ctranslate2's stderr and has nothing to do with prompts.

`requestClips` takes its configuration as an argument rather than importing
`env`, so both processes supply their own and tests supply neither. `fetch` is
injectable for the same reason `subscribe` takes `SubscribeDeps` in
`frontend/src/lib/api.ts` — so a test can assert what was sent without a network.

### One table, not two

```ts
export const recommendationRounds = pgTable('recommendation_rounds', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
  /** NULL = the opening round, carried free from the analyse stage's surplus. */
  userMessage: text('user_message'),
  candidates: jsonb('candidates').$type<Candidate[]>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
```

The chat history *is* the round list ordered by `createdAt`, and the live list is
the newest round's `candidates`. A separate messages table would store one row
per round carrying one nullable string, joined to the round it already belongs
to.

No `userId`: ownership resolves through `jobId → jobs.userId`, which
`shared/schema.ts` calls the single owner column — *"every ownership check in the
API resolves to this one"*.

No "was this turned into a clip" column either. The results screen already loads
the job's clips, so *already created* is an overlap test against them, computed
where it is read. A column would be a second copy of a fact that can drift.

### Creating clips reuses the copy path

`POST /jobs/:id/clips` is `POST /clips/:id/copy` with a different source for the
title and range, and it keeps both of that route's guards for the reasons already
written above them:

- `isTerminal(job.status)` → 409, **not** `=== 'completed'`. A project cancelled
  after its clips rendered must still accept new ones.
- `quotaVerdict` with `dailyLimit: Infinity` and the real storage ceiling —
  *"the daily quota counts jobs, and this creates clips inside one that is
  already paid for. The storage ceiling is the honest limit to apply."*

The body is `{ roundId, indices }`, not raw ranges. The server re-reads the
stored candidate, so a client cannot post arbitrary timestamps even though
`trimError` would catch them anyway.

Rendering needs no new code. `recutClip` cuts whatever range is on the row it is
handed, and its delete-the-previous-renders step is a no-op for a row that has
none — the property the copy route already relies on.

### Two new refusals

- No `transcripts` row for the video → 409, *"Regenerate this project to enable
  recommendations."* The transcript is what the model reads; without it there is
  nothing to recommend from.
- Job not terminal → 409, same wording as copy. A job mid-render is about to
  rewrite its own clips.

### Prompt injection

Chat is multi-turn user-authored text pasted into a prompt, so it gets the
`briefBlock` treatment per message, and for the same three reasons in the same
order:

1. **Position.** Every message lands after the rules. By the time the model
   reads one, the hard constraints have been stated, so a message can only
   reorder what gets picked, never widen what is allowed.
2. **Fencing.** A line equal to the delimiter is dropped, or a user typing
   `USER_BRIEF` alone on a line closes the fence early and the rest of their
   text reads as our instructions.
3. **Structure**, which is the one that actually holds. The response is pinned
   to a strict JSON schema, so only clip objects can come back, and
   `validateRanges` then discards anything out-of-window or overlapping
   regardless of what any message said.

`briefBlock` generalises to `fencedUserText(label, text)` so the job brief and a
chat message share one implementation and one test.

### The flag, and the comment on `/me`

`RECOMMENDATIONS_ENABLED` **defaults to true**. The requirement is an off
switch, not an opt-in. `EDITOR_ENABLED` defaults false for a reason that does
not apply here — that feature is mid-rework and must not come back by
forgetting.

`routes/auth.ts` says of `editorEnabled`:

> If more flags follow, move them to their own endpoint — this is one field's
> worth of pragmatism, not a pattern.

This is that second flag. `/me` now returns

```ts
features: { editor: boolean, recommendations: boolean }
```

and `editorEnabled` is removed rather than kept alongside. This honours the
comment's intent — flags are one named thing, not a widening row of sibling
booleans — while declining its letter: a separate endpoint would add a second
boot round-trip to fetch two booleans the first one could have carried.

## Shape of the change

**shared/** — `clipPrompt.ts`, `clipRanges.ts`, `openrouter.ts` (new);
`schema.ts` gains `recommendationRounds`; `types.ts` gains
`RecommendationDTO`, `RecommendationRoundDTO`, `MAX_CHAT_CHARS`,
`RECOMMEND_POOL`.

**backend/** — `env.ts` gains `RECOMMENDATIONS_ENABLED` and the `OPENROUTER_*`
trio; `recommendationsGate.ts` (new, mirroring `editorGate.ts`);
`routes/recommendations.ts` (new, three routes); `routes/auth.ts` `/me` returns
`features`; one Drizzle migration.

**worker/** — `pipeline.ts` slices the ranked list and inserts the opening
round; `stages/analyze.ts` becomes a thin wrapper over `requestClips`;
`parse.ts` and `ranges.ts` shrink to their moved-out remainder.

**frontend/** — `RecommendationPanel.tsx` (new) on `ResultsScreen`;
`useSnipline.ts` gains recommendation state and four actions; `api.ts` gains the
three calls and the `features` type; `App.tsx` and `ResultsScreen.tsx` migrate
off `user.editorEnabled` to `user.features.editor`.

## Testing

Pure, no network: `fencedUserText` drops a delimiter line and survives
absence of one; `buildRecommendPrompt` places messages after the rules and
carries the avoid-ranges; `validateRanges` at a raised `count` returns a
superset of the same call at a lower one, which is the property the surplus
slice depends on.

Routed, with a stubbed `fetch`: the gate 404s when the flag is off (asserting
the gate's body, not the handler's, as `editorGate.route.test.ts` does);
ownership; non-terminal 409; missing-transcript 409; storage-quota refusal;
`indices` outside the round are rejected.

Frontend: the panel is hidden when the flag is off, a row click creates one
clip, and a multi-select creates the number selected.

## Known ceilings

- **Every turn re-sends the whole transcript.** A two-hour video is a few
  thousand lines per message. That is the price of unlimited free re-rolls;
  the upgrade path is a retrieval step that sends only the neighbourhood of the
  moments being discussed.
- **Only the newest round is live.** Recovering an earlier list means asking
  again. Rounds are all stored, so showing history is a frontend change alone.
- **Clip creation does not touch the daily job quota**, matching the copy route.
  A user can therefore add clips to a finished project indefinitely, bounded
  only by storage. That hole exists today via the editor; this widens it.
