# Editor preview: always show something, and backfill what is missing

2026-09-22

The editor shipped with a real preview, and on the deployed box it shows a
hatched placeholder. This makes the preview behave the way a video editor's
preview behaves: there is always a picture, and scrubbing the timeline moves it.

## 1. Root cause

Not an encode bug. The stage was verified against a synthetic source before any
of this was written:

```
proxy   h264 426x240, 40.0s, moov at byte 36, mdat at 34484  -> faststart, seekable
strip   2048x72                                              -> 16 tiles of 128x72
peaks   150 buckets, 150 non-zero
```

Two separate reasons no clip on the server has one:

**The deployed worker never ran the new code.** `.github/workflows` invokes
`scripts/deploy.sh --pull --skip-worker`, and `--skip-worker` sets `DO_WORKER=0`
(`deploy.sh:50`), which drops `clip-worker` from the pm2 restart list
(`deploy.sh:363`). The API and the frontend updated; the worker did not. The
migration did run — only `--skip-api` skips that — so the columns exist and are
uniformly null.

**Every clip predating the merge has `proxy_key = null` anyway.** That is the
"degrade gracefully" path chosen in the 2026-09-21 design. It works as
specified; the specification was wrong about what it would feel like.

> **Operational prerequisite.** Restarting `clip-worker` on the box is required
> before any of this can help. A worker on old code cannot build assets and
> cannot consume the new queue either. `--skip-worker` is presumably deliberate,
> so that the deploy cannot kill an in-flight job — but it means every worker
> change needs a deliberate restart, and this one does too.

## 2. What "like a common video editor" means here

Three properties, in priority order:

1. **The preview is never empty.** Something plays the moment the editor opens.
2. **Scrubbing the timeline moves the picture.** Dragging a handle shows the
   frame it lands on.
3. **You can see outside the cut**, because that is the only way to judge
   whether the in point should move earlier.

A clip with a proxy already has all three. A clip without one can have the first
two immediately, from a file that already exists: its own rendered output.

## 3. Design

### 3.1 A preview source, rather than "the proxy or nothing"

The screen stops asking "is there a proxy" and asks "what can I play, and what
stretch of source does it cover":

```ts
type Preview = {
  url: string
  /** First second of SOURCE this file shows. */
  start: number
  /** How many seconds of source it shows. */
  span: number
  /** Whether it covers the whole timeline or only the cut. */
  kind: 'proxy' | 'render'
}
```

- **proxy** — `start = win.start`, `span = win.span`. Covers the whole timeline.
- **render** — `start = clip.s`, `span = clip.e - clip.s`. Covers only the cut,
  and is the already-rendered vertical MP4 that every ready clip has today.

Everything downstream is one conversion: `videoTime = sourceSeconds -
preview.start`. Seeks outside `[0, span]` clamp, so with a render-backed preview
the handles still move and the timeline still reads correctly — the picture just
holds at the nearest frame it actually contains. The screen says so in a line of
text rather than leaving the user to wonder.

This alone fixes "the preview is empty" for every existing clip, with no worker
involvement at all.

### 3.2 Backfill, so the proxy eventually arrives

A new queue, because the work is a download plus N encodes and does not belong
on a web request:

```ts
export const BACKFILL_QUEUE = 'backfill-assets'
export interface BackfillJobPayload { jobId: string }
```

The handler downloads the source **once** and builds assets for every clip in
the job that lacks them. Per job, not per clip: twelve clips of one video must
not mean twelve downloads of that video. `singletonKey: jobId` collapses a
second request while one is in flight.

`POST /api/jobs/:id/assets` enqueues it, guarded by `ownedJob`, answering 409
unless the job is `completed` and 204 when every clip already has its assets.

The editor requests it on open when the clip has no proxy, then polls the job
until `proxyUrl` appears — the same shape as the existing re-cut poll — and
swaps the preview from `render` to `proxy` when it does. A failure or a timeout
is not fatal: the render-backed preview is still there.

### 3.3 A finished job must stay finished

`ensureDownloaded` calls
`setStatus(jobId, { status: 'downloading', stage: 'Downloading source' })`
(`pipeline.ts`). On a completed job that is wrong, and it is already wrong
today: "Regenerate this clip" flips the whole project back to `downloading`, so
the results screen sees `jobStatus: 'downloading'` and `jobDone: false`, and a
second re-cut 409s because `/redo` requires `status === 'completed'`.

It gains a `quiet` option that suppresses the status write and the progress
reports, used by both `recutClip` and the backfill. The download still happens
and the disk guards still run; only the job's public status is left alone.

This is in scope because the backfill runs on completed jobs by definition — it
would corrupt the status of every project it touched — and because it is the
root cause rather than a symptom.

## 4. What this does not do

- No `yt-dlp --download-sections`. Downloading only the window would make a
  backfill much faster, but amortising one full download across a whole job's
  clips already avoids the pathological case, and a new download path is a new
  way to get a corrupt file.
- No batch backfill of every project at once. Opening a project's editor is the
  trigger; a box with many projects should not decide by itself to download all
  of them.
- No change to `.github/workflows`. Whether a deploy restarts the worker is a
  deployment decision, and silently flipping it could kill a running job.

## 5. Testing

- `worker` — the backfill handler picks exactly the clips missing assets, and
  downloads once for a job with several of them.
- `backend` — `POST /api/jobs/:id/assets` is owner-guarded, 409s on an
  unfinished job, and 204s when there is nothing to do.
- `frontend` — `previewFor` as a pure function: proxy preferred; falls back to
  the rendered clip for the current ratio; null when neither exists; and the
  source-seconds to video-time conversion for both kinds.
