# Editor screen: real functionality

2026-09-21

The editor screen has matched its design since Tier A, but everything behind it
is a mock. This makes it real: actual playback, actual transcript, actual trim,
and a save that re-renders.

## 1. What is wrong today

`frontend/src/screens/EditorScreen.tsx` renders the design faithfully and means
none of it:

- The preview is a dashed box with `clip.line` printed in it. No video.
- The playhead is a `setInterval` in `useSnipline.ts` advancing a number by 0.7
  every 90ms. It is not attached to anything.
- The filmstrip is 16 hatched divs. The waveform is `WAVE`, a hand-written array
  of 28 percentages in `data/fixtures.ts`.
- The transcript is four lines built inline from the clip's single `sn` snippet,
  two of them hardcoded English sentences about deleting a database.
- `DEFAULT_TRIM` is `{ trimIn: 22, trimOut: 54 }` — fixed percentages, identical
  for every clip, so the handles open in the wrong place for all real content.
- "Save & download" navigates away and says *"Editor edits are not saved yet."*
- "Regenerate this clip" is a toast. "Rewrite" flips a boolean and prefixes the
  caption with the word `Rewritten:`. "Copy" toasts `Caption copied.` without
  touching the clipboard.
- The crop buttons set `state.ratio`, which nothing downstream reads.

The 2026-09-20 pipeline design deferred all of this deliberately (§2, §11):
*"Editor screen (real playback, filmstrip thumbnails, waveform, re-render on
save)"*.

## 2. The blocker, and the shape of the fix

**The source video does not survive its job.** `worker/src/pipeline.ts` runs
`rm -rf workDir` and nulls `videos.scratchPath` on every exit path, and the
source is never uploaded — object storage holds only per-ratio rendered MP4s,
their JPG thumbnails, and one SRT per video. `GET /api/media/:file` resolves
keys exclusively from the `renders` row. There is nothing to stream.

So real playback requires a new persisted artifact. It is built **during the
job**, per clip, covering only the 150-second timeline window the editor can
actually show (`TIMELINE_LEAD_IN` 30 + `TIMELINE_SPAN` 150). One ffmpeg pass
yields all three missing pieces — proxy, filmstrip, waveform — and the editor
opens instantly rather than stalling on a re-download.

Cost at 240p/~300kbps: roughly 6MB per clip, ~70MB for a 12-clip job, against a
5GB per-user quota (`QUOTA_STORAGE_GB`). 1.4%.

Rejected: building the proxy on demand (needs a new queue and a 20–60s wait on
first open — an editor that stalls before you can scrub is not an editor), and
previewing the rendered clip instead (the trim handles would be lying, since
moving them would change nothing on screen until a re-render).

## 3. Data model

Migration `backend/drizzle/0006_*.sql`, generated from `shared/schema.ts`. Five
columns on `clips`:

| column | type | meaning |
|---|---|---|
| `proxy_key` | `text` nullable | object key for the 240p window MP4 |
| `strip_key` | `text` nullable | object key for the filmstrip sprite JPEG |
| `peaks` | `jsonb` (`number[]`) nullable | ~150 RMS values, 0–100 |
| `window_start` | `double` nullable | first second of source the proxy covers |
| `window_span` | `double` nullable | proxy duration in seconds |
| `asset_storage` | `text` → `storage_backends.id`, default `'minio'` | which backend holds the two keys |

All nullable. A null `proxy_key` is the signal that a clip predates this work,
and is what makes old jobs degrade instead of break (§7).

`asset_storage` mirrors the existing `renders.storage` column for the same
reason it exists there: deletes must go to the backend that actually holds the
object, not to whichever one is active today.

`window_start` and `window_span` are **stored, not recomputed**. The window
clamps at both ends of the source — a clip at t=10 cannot have 30 seconds of
lead-in, and a clip near the end cannot have a full 150-second span. If the
frontend recomputed `clip.s - TIMELINE_LEAD_IN` it would map the timeline to the
wrong frames for exactly those clips. `windowFor()` reads the row, and falls
back to today's arithmetic only when the columns are null.

Object keys join the existing scheme in `shared/s3.ts`:

```
jobs/${jobId}/clips/${clipId}/proxy.mp4
jobs/${jobId}/clips/${clipId}/strip.jpg
```

## 4. Worker

One new stage, `worker/src/stages/editorAssets.ts`:

```ts
buildEditorAssets(opts: {
  sourcePath: string
  clip: Clip
  workDir: string
  videoDurationSeconds: number
}): Promise<{ proxyPath: string; stripPath: string; peaks: number[]; windowStart: number; windowSpan: number }>
```

Called from the clip loop in `pipeline.ts` while `sourcePath` still exists,
**wrapped in try/catch**. A failed proxy must never fail a render — the same
best-effort posture as the SRT upload, which already nulls `srtKey` rather than
failing the job. Three plain ffmpeg invocations rather than one `filter_complex`,
because three legible commands beat one clever one that is hard to debug when a
codec is missing:

1. **proxy** — `-ss <windowStart> -i <src> -t <windowSpan> -vf scale=-2:240
   -c:v libx264 -preset veryfast -crf 32 -c:a aac -b:a 48k -ac 1
   -movflags +faststart`.
   `+faststart` is load-bearing: without the moov atom at the front, `<video>`
   cannot seek over range requests and scrubbing does nothing.
2. **filmstrip** — derived from the *proxy*, not the source, so it costs almost
   nothing: `-vf fps=16/<span>,scale=-2:72,tile=16x1` → a single JPEG.
3. **peaks** — decode the proxy to `s16le` mono 8kHz on stdout and bucket to 150
   RMS values in JS. The bucketing is a pure function and is where the unit test
   goes.

`recutClip` regenerates all three, because a saved trim moves `clip.s` and
therefore moves the window. `deleteJobArtifacts` learns to remove both keys.

Whisper is **not** re-run and is not asked for `--word_timestamps`. Segment
timings are what the transcript panel needs and what already exists.

## 5. Backend

Two new endpoints, one extended.

**`GET /api/clips/:id/transcript`** — `ownedClip`-guarded, returns
`{ segments: TranscriptSegment[] }` from the `transcripts` table, filtered to
those overlapping the clip's window. The table has stored these permanently
since Tier A, keyed by video; no route has ever exposed it.

**`PATCH /api/clips/:id`** — body `{ s: number, e: number }`. Validates
`0 <= s < e <= video.durationSeconds`, a minimum length of 3 seconds, a maximum
of the window span, and `job.status === 'completed'` (409 otherwise, matching
`/redo`). Writes `start_seconds`/`end_seconds` and returns the updated `ClipDTO`.

It deliberately **does not enqueue**. `recutClip` already re-renders from
`clips.start_seconds`/`end_seconds`, so saving a trim is PATCH followed by the
existing `POST /clips/:id/redo`, and the queue payload
(`RecutJobPayload { jobId, clipId }`) is untouched. This is the whole reason the
save path is cheap.

Validation lives at the trust boundary because custom in/out points bypass
`validateRanges` entirely — that only runs inside `processJob`.

**`GET /api/media/:file`** gains `kind: 'proxy' | 'strip'`, resolved from the
`clips` row rather than `renders`. The existing HMAC payload is already
`${kind}:${clipId}:${ratio}:${exp}`, so `kind` is signed and the token format
does not change; `ratio` is passed as a constant for these kinds. The file regex
`^<uuid>\.(mp4|jpg)$` already admits both extensions. Session and `ownedClip`
checks are unchanged.

`toClipDTOs` in `backend/src/mappers.ts` grows four nullable fields:

```ts
proxyUrl: string | null
stripUrl: string | null
peaks: number[] | null
win: { start: number; span: number } | null
```

## 6. Frontend

`EditorScreen.tsx`:

- The preview box holds a `<video>` sized to the chosen ratio with
  `object-fit: cover`, `clip.line` still overlaid as the design shows.
- The playhead is driven by `timeupdate`, and playback loops `trimIn → trimOut`.
  Dragging a handle, clicking a transcript line, or scrubbing the track seeks it.
- The filmstrip is `<img src={stripUrl}>` stretched across the track.
- The waveform reads `clip.peaks`.
- The transcript is fetched from the new endpoint on open.
- Crop buttons for ratios the job never rendered are `disabled`, not pickable.
  A job renders only the formats it was started with, so offering the others
  promises a file that does not exist.
- Copy calls `navigator.clipboard.writeText`. Rewrite is removed — it was a
  string prefix, and LLM rewriting is out of scope.
- Regenerate calls the `redoClip` that already exists in `useSnipline`.
- Save & download runs PATCH → redo → poll → download, staying on the screen
  with the button busy. A save costs a full yt-dlp re-download of the source, so
  it takes minutes, not seconds; the poll mirrors `redoClip`'s existing one.

`useSnipline.ts`:

- `openEditor` derives the initial trim from `clip.s`/`clip.e` against the real
  window instead of the constant `DEFAULT_TRIM`.
- The `setInterval` playback is deleted.
- **`playing` and `playhead` move out of the global state object into the
  screen.** `timeupdate` fires roughly four times a second; leaving the playhead
  in `useSnipline` would re-render the entire app on every tick. This is a
  targeted improvement to code the change already touches, not a general
  refactor.

## 7. Degradation

Clips from jobs that predate this work have `proxy_key = null`. The editor still
opens and the transcript, trim and save all work — those need no new artifact.
The preview box and filmstrip keep today's hatched placeholder and the `WAVE`
fixture, under a one-line note explaining that this project was made before
previews existed and that regenerating it will produce one.

## 8. Testing

- `shared` — the peak-bucketing pure function: known PCM in, expected buckets
  out, including a silent run and a span shorter than the bucket count.
- `backend` — `PATCH /api/clips/:id` rejects `s >= e`, a range past
  `durationSeconds`, a sub-3s window and a job that is not `completed`; the
  media route resolves `proxy`/`strip` kinds from the clips row and still 403s a
  bad signature; the transcript route returns only overlapping segments.
- `frontend` — `EditorScreen` renders both with and without proxy assets, and
  the opening trim derives from the clip rather than a constant.

## 9. Out of scope

- Word-level subtitle timings. `whisper-ctranslate2` is not invoked with
  `--word_timestamps` and `transcribe.ts` discards anything but
  `{start, end, text}`. Karaoke captions would need both changed.
- LLM caption rewriting.
- Editing the burned-in subtitle text. `buildClipAss` burns transcript speech,
  not `clip.cap`; a custom burn has no code path today.
- Retaining the full source video, or serving it. Only the 150-second window is
  kept.
