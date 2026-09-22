# Manual Clipping and Source Retention — Design Spec

**Date:** 2026-09-22
**Status:** Awaiting review
**Scope:** Let a user cut a clip from anywhere in the source video, and bound
the storage that makes it possible.

---

## 1. Problem

The editor can only see 150 seconds of the source. `windowFor(clip)` pins that
window 30 seconds before the clip it was opened from, and the three assets the
timeline needs — proxy, filmstrip, waveform — are cut to that window.
`editorAssets.ts` says why in its header:

> *"Only the timeline window is kept, not the whole video. The editor can never
> scrub outside it, and a 150-second 240p proxy is ~6MB against a 5GB quota
> where the source would be gigabytes."*

So a user who wants a moment the AI did not pick has no way to reach it.

The obvious reading of this — "store the original video so the editor can play
it" — is more expensive than it needs to be, and on this box it is dangerous.
See §3.

## 2. Scope

**In:**

- A full-length low-resolution proxy, overview filmstrip and full-length
  waveform, built per **video** and shared across jobs and users
- A manual mode in the editor that moves the existing 150-second window
  anywhere in the source
- Retention: a byte budget, least-recently-used eviction, and a TTL sweep
- A `bun run proxies` script to inspect and force retention

**Out:**

- Storing the original download. Renders keep re-downloading, as re-cut already
  does (§3).
- Raising the 150-second clip ceiling. `trimError` enforces it today and this
  changes nothing about it (§4).
- A new save path. `POST /clips/:id/copy` already accepts an absolute range.
- Charging these assets to a user's storage quota. They are shared and belong
  to no one (§7).
- Worker concurrency. A long build blocks the queue; named as a known cost in
  §6.4, not fixed here.

## 3. Decisions taken before designing

Three forks were settled with the user up front, because each changes the
weight of everything downstream.

**Store a full-length proxy, not the original.** The editor needs something
scrubbable, not something broadcast-quality: it plays a 240p proxy today and
would play a 240p proxy in manual mode. The final render does not need a stored
original either, because `recutClip` already re-downloads the source on every
re-cut and has since it was written.

The accepted cost: a render still depends on the video still existing upstream.
If it is pulled from YouTube, the clips already rendered are safe and the
timeline still scrubs, but a *new* cut of that source will fail.

The numbers that decided it, on the box this actually runs on:

| | |
|---|---|
| Disk | 58 GB total, **20 GB free**, shared with 7 other applications |
| MinIO today | 1.36 GB |
| Worker refuses to download below | `MIN_FREE_DISK_GB = 5` |
| Download format | `bv*[vcodec^=avc1]+ba[acodec^=mp4a]` — **no height cap** |

That format selector takes the best available, so an hour of 1080p is roughly
1.5–3 GB and a 1440p source is more. Ten stored originals could fill the disk,
and below 5 GB free the worker stops accepting **all** jobs. A full-length 240p
proxy is ~120 MB/hour — 10–20× cheaper, and it is the artefact the editor
actually uses.

**Retention is a byte ceiling with least-recently-used eviction**, not a count
cap with oldest-first eviction. A count cap does not track the thing that fills
a disk: the corpus ranges from a few minutes to 3h41m, so "20 videos" is
anywhere between 400 MB and 8.8 GB. And oldest-*created* eviction deletes the
source a user is editing this week because they first analysed it months ago,
while sparing one they opened once and abandoned. Least-recently-*used* is the
same amount of code and structurally cannot evict what is in use.

**Build lazily, on first entry into manual mode.** Projects nobody edits cost
nothing. The accepted cost is a wait on first edit — the source must be
re-downloaded — which is minutes for a typical video and 10–20 minutes for the
3h41m outlier. Building eagerly during the job would avoid the download but add
that encode to **every** job, including the many never edited, which retention
would then evict anyway.

## 4. What manual clipping actually is

`trimError` (`backend/src/routes/clips.ts`) already accepts any range in the
whole video: in before out, at least `MIN_CLIP_SECONDS`, at most `EDITOR_SPAN`,
not past the end. Every precise control in the editor — handles, ±1s nudges,
transcript-click-to-trim, `i`/`o`, save-as-new-clip — already operates on an
arbitrary 150-second span.

Manual mode therefore is not a new editor. It **unpins the window**:

```
TODAY          [====== whole video, 3h41m ======]
                        ^ window pinned to the clip
                        [30s lead-in|--- clip ---|]
                        <----- 150s, scrubbable ----->

MANUAL MODE    [====== whole video, 3h41m ======]
                ^--- window goes anywhere you drop it ---^
                        [--- the same 150s detail UI ---]
```

Two levels are not a preference, they are forced: 3h41m across a 1000px
timeline is 13 seconds per pixel, so a single-level timeline cannot place a
3-second cut. The fine half already exists; this adds the coarse half.

Saving is unchanged. `POST /clips/:id/copy` takes `{s, e}` in absolute source
seconds, validates against `video.durationSeconds`, copies the clip row and
enqueues a re-cut. **No new route, no change to rendering, no change to the
pipeline.**

### Assets required

| Asset | Covers | Purpose | Size |
|---|---|---|---|
| Full proxy `proxy.mp4` | whole video, 240p | scrub and preview anywhere | ~120 MB/hour |
| Overview filmstrip `strip.jpg` | whole video | see where you are placing the window | one sprite |
| Full-length peaks | whole video | find speech vs silence at a glance | ~60 KB worst case |

Per-clip assets are untouched. They are cheap, already built and backfilled,
and remain what the editor uses outside manual mode.

## 5. Data model

### Keys

Per-video, mirroring the transcript convention that is already per-video and
shared across jobs and users:

```
transcripts/${videoId}.srt        exists today
videos/${videoId}/proxy.mp4       new
videos/${videoId}/strip.jpg       new
```

### Columns on `videos`

Deliberately mirroring the per-clip asset columns one for one:

```ts
/**
 * Editor assets for the WHOLE source, built only when someone opens manual
 * mode. Per-video and therefore shared: the second user to edit a popular URL
 * pays nothing, exactly as they already pay nothing for its transcript.
 *
 * All nullable. A null proxyKey means "never built, or evicted" -- the two are
 * indistinguishable on purpose, because the response to both is to rebuild.
 */
proxyKey: text('proxy_key'),
stripKey: text('strip_key'),
/** RMS levels 0-100, ONE PER SECOND of source. */
peaks: jsonb('peaks').$type<number[]>(),
/** Which backend holds proxyKey and stripKey. Same name and meaning as clips. */
assetStorage: text('asset_storage').references(() => storageBackends.id),
/**
 * proxy + strip. The retention budget sums this, never the bucket.
 *
 * `integer`, matching clips.proxy_bytes rather than reaching for bigint: it
 * overflows past ~2.1 GB, which at 120 MB/hour is a 17-hour source. Matching
 * the column it mirrors is worth more than guarding a case YouTube cannot
 * produce.
 */
proxyBytes: integer('proxy_bytes'),
/** Last time the editor asked for these. The eviction order IS this column. */
proxyUsedAt: timestamp('proxy_used_at', { withTimezone: true }),
```

Additive and nullable. The migration backfills nothing: every existing video
reads as "not built yet".

### Why peaks are one per second

The per-clip waveform is 150 buckets over a 150-second window — one bucket per
second. Holding that same density for the whole video lets one array serve both
timelines: the overview downsamples to ~1200 bars in the browser, and the
detail band takes `peaks.slice(start, start + 150)` — the exact numbers the
per-clip waveform would have shown. No second asset, no second encode.

Cost is `duration_seconds` integers: ~2,500 for a 43-minute video, ~13,000 for
the 3h41m outlier, about 60 KB of JSONB at worst. `clips.peaks` is already
`jsonb`; this is the same shape, longer.

### Serving

Two new kinds on the **existing** media route, resolved `clip -> job -> video`:

```
GET /api/media/:clipId.mp4?kind=source       -> videos.proxy_key
GET /api/media/:clipId.jpg?kind=sourcestrip  -> videos.strip_key
```

A video is shared between users, so a `videoId`-keyed URL would have needed a
new ownership rule ("do you own *any* job on this video") and a second signing
path. Keying on the clip the editor is already open on means the HMAC, the
signature check and the ownership check are **unchanged**; only the key lookup
moves one join further. `parseKind` gains two entries.

Peaks need no signing and ride in the job DTO as plain JSON, as `clip.peaks`
does now.

### Deliberately absent

**No filmstrip in the detail band while in manual mode.** A 16-frame strip for
an arbitrary window cannot be sliced out of a 120-frame overview of a four-hour
video, and building one per window would mean an encode per drag. Manual mode
shows the overview strip, the waveform and the live video. On save, the new
clip gets a real per-clip strip from the backfill that already exists. Drawing
it client-side from the proxy onto a canvas is the obvious later upgrade.

## 6. Building

### 6.1 Trigger

```
POST /api/jobs/:id/source
  -> 409 if the job is still in flight   (isTerminal)
  -> { ready: true }            proxy exists; proxy_used_at stamped
  -> { ready: false, pending }  build enqueued
```

That stamp is the whole LRU mechanism: eviction order is `ORDER BY
proxy_used_at`. No access log, no counters.

### 6.2 Queue

A new `SOURCE_QUEUE`, not a flag on `BACKFILL_QUEUE`, because the unit of work
differs:

| | payload | `singletonKey` |
|---|---|---|
| `BACKFILL_QUEUE` | `{ jobId }` | jobId |
| `SOURCE_QUEUE` | `{ videoId, jobId }` | **videoId** |

Keying on the video is what makes the sharing real: two users editing the same
URL, or one user editing two projects from it, collapse into one download and
one encode. A `jobId` key would do the work twice.

`jobId` rides along only to satisfy `ensureDownloaded`'s signature. That
parameter becomes `string | null`, with `announce` skipping on null, so the
code stops implying a job is involved when none is.

### 6.3 Worker stage

`buildSourceProxy(videoId, jobId)`, mirroring `backfillAssets` including its
error posture:

1. Re-check `video.proxyKey`; another build may have won the race — touch and
   return.
2. `storage.active()`, `mkdir source-${videoId}`.
3. `ensureDownloaded(..., { quiet: true })`. The disk guards come free.
4. Three ffmpeg passes — the same three `buildEditorAssets` runs, without the
   `-ss`/`-t` window:
   - **proxy**: `scale=-2:240`, CRF 32, `-g 25`, `+faststart` (load-bearing:
     without the moov atom at the front, range-request seeking silently fails)
   - **strip**: `OVERVIEW_FRAMES = 120` evenly spaced, one row ≈ 9600×45 px,
     under the 16384 px texture limit
   - **peaks**: one bucket per second
5. Upload, write the six columns, stamp `proxy_used_at`.
6. Run retention (§7). Build first, then evict, so the new asset is the most
   recently used and cannot evict itself.
7. `finally`: `rm -rf` the work dir and null `scratchPath`, as every other path
   in that file does.

Failures are logged and swallowed. A failed source build must not make a
finished project look broken.

### 6.4 Known cost

`boss.work` is `batchSize: 1` and `WORKER_CONCURRENCY` is dead code, so the
worker is strictly sequential. A 15-minute source build delays every queued job
behind it. The `videoId` singleton prevents duplicates but not this.

Accepted for v1 and written down rather than fixed here — worker concurrency is
its own work, with its own `scratchPath` hazards. The upgrade path if it bites:
give `SOURCE_QUEUE` its own `boss.work` registration so source builds and clip
jobs drain independently.

### 6.5 Waiting

Reuses `preparePreview`'s shape: call the route, poll `getJob` every 10 s,
watch for `source.proxyUrl`. Manual mode is offered immediately but disabled
with:

> Preparing the full timeline. The source is re-downloaded, which usually takes
> a few minutes.

The existing 15-minute give-up stays. A long build may outlive it; **the build
continues server-side** and reopening manual mode later finds it ready. The UI
says so. Giving up on the poll is not giving up on the work.

## 7. Retention

```
PROXY_BUDGET_GB      = 6     hard ceiling on total proxy bytes
PROXY_TTL_DAYS       = 30    untouched this long -> gone regardless of budget
PROXY_GRACE_MINUTES  = 30    never evict something used this recently
```

20 GB free, minus 6 GB of proxies, leaves ~14 GB for scratch downloads and the
other applications. That is not generous: a four-hour 1080p source can be an
8 GB scratch download by itself. At ~120 MB/hour, 6 GB is about 50 hours of
source; the current corpus is 10.7 hours.

*(Unrelated exposure, noted not solved: the per-user quota is 5 GB across 4
accounts, so renders alone could claim 20 GB. That is why the proxy budget is
not set higher without raising the disk.)*

### Rule

```
after every successful build, and on worker startup:

  evict where proxy_used_at < now() - PROXY_TTL_DAYS        (period)

  total = SUM(proxy_bytes) WHERE proxy_key IS NOT NULL
  while total > PROXY_BUDGET_GB:
      v = oldest proxy_used_at, EXCLUDING the grace window
      if no such row: warn and stop
      delete v's objects, null v's columns
      total -= v.proxy_bytes
```

Running it after each build means the operation that grows storage is the one
that shrinks it — no scheduler to forget.

### Safety property

**If every candidate is inside the grace window, retention stops and logs. It
does not evict.** Being briefly over budget is recoverable; pulling a 400 MB
proxy out from under an active edit is not. The next build or startup retries,
by which time the window has moved.

Combined with the `proxy_used_at` stamp on every entry into manual mode, the
video being worked on is structurally the last thing eligible for eviction.

### Deleting safely

Objects first, row second — the rule `users --delete` already follows, for the
same reason: the row holds the only record of the keys, so nulling it first
makes the object unreachable and permanently invisible.

```ts
// Grouped per backend: a proxy may predate the current write target, and
// aiming its key at the wrong bucket deletes nothing while reporting success.
await storage.deleteMany([
  { storage: v.assetStorage, key: v.proxyKey },
  { storage: v.assetStorage, key: v.stripKey },
])
```

`storage.deleteMany` currently swallows per-backend failures so it can never
abort an account delete halfway. Retention needs to know, because an object
whose row was nulled after a failed delete is an orphan no sweep will ever find
again — exactly the leak retention exists to prevent. It gains a return value
naming the backends that failed; on failure the row is left intact and the next
sweep retries. Self-healing, and existing callers ignore the return.

The three assets are evicted together, never partially. Keeping `peaks` alone
would save 60 KB and one ffmpeg pass on rebuild, which is not worth a second
state to reason about.

### Consequences

- **Eviction is global, not per-user.** The proxy is shared per video and
  cannot be charged to anyone. A frequent editor keeps sources warm; an
  infrequent one pays a rebuild. That is the cost of the sharing that makes the
  second editor of a URL free.
- **Nothing is ever lost.** An evicted proxy is indistinguishable from one never
  built, and both rebuild on demand. The only casualty is time.
- **Project and account deletion do not touch it.** `deleteJobArtifacts` removes
  renders, `videos` rows are never deleted, and a shared proxy must survive one
  owner leaving. No change needed — stated so nobody adds one.

### Visibility

`bun run storage` already reports objects and bytes per backend. `bun run
proxies` joins it: list what is stored with size, age and last use, and
`--sweep` to force retention by hand. There is no scheduler in this
application, and an explicit escape hatch is better than a cron entry nobody
remembers.

## 8. Failure modes

| Situation | Behaviour |
|---|---|
| Source pulled, geo-blocked or age-gated | Build fails, logged, swallowed. Manual mode unavailable; the per-clip window still works. Already-rendered clips are untouched. |
| yt-dlp stale | `assertYtdlpFresh` throws before the download. Existing guard. |
| Disk too low | `assertDiskSpace` refuses before downloading. Nothing partially written. |
| Upload fails midway | Row stays null; next attempt rebuilds. Keys are deterministic, so a retry overwrites rather than accumulating. |
| Two users open manual mode on one video | `singletonKey: videoId` collapses them into one build. |
| Proxy evicted mid-scrub | Grace makes it unlikely. The media route 404s, the editor falls back to the clip window and offers manual mode again, which re-enqueues the build. |
| `proxy_bytes` drifts from the bucket | Budget mis-counts. Observable via `bun run storage`; `proxies --sweep` recomputes. Not self-correcting in v1. |
| Worker down | Nothing builds; the editor polls 15 min then says it is still preparing. Identical to the backfill today; `worker-check.sh` finds the cause. |
| Active backend has no credentials | `storage.active()` throws, swallowed, manual mode unavailable. The worker already refuses to start in that state. |
| Duration 0 or audio-only source | Guarded on `durationSeconds > 0` before any ffmpeg runs. |

## 9. Testing

**Pure, no database or network** — the house style of `quotaVerdict`,
`reconcileVerdict` and `trimError`:

`evictionPlan(rows, { budgetBytes, ttlDays, graceMinutes, now })` returns the
ordered list to evict. It is the only part of this feature that can silently
destroy data, so it is pure and tested:

- evicts least-recently-used first
- never returns a row inside the grace window
- returns empty and warns when every candidate is in grace, rather than evicting
- TTL-expired rows go regardless of budget
- already under budget → empty plan
- a null `proxy_bytes` counts as 0 and cannot wedge the loop

Plus the frontend pure helpers: peaks downsampling, window slicing, and the
unpinned window clamping at both ends of the source.

**Integration, opt-in behind `RUN_DB_TESTS=1`:**

- `POST /jobs/:id/source` returns `ready` and stamps `proxy_used_at` when the
  proxy exists
- it 409s while the job is in flight, and does not for a terminal one
- `kind=source` serves an owned clip and 404s a foreign one — the ownership
  join moves one table further, so this one is security-relevant

**Not automatable in this environment, and stated rather than implied:** the
ffmpeg passes and a real eviction against MinIO. Those are the rollout checks.
The route's `pending` branch enqueues onto pg-boss and is not exercised in
tests, for the same reason the other routes' enqueues are not.

## 10. Rollout

**Phase 0 — schema, pure retention, script.** Migration additive and nullable;
`evictionPlan` and `bun run proxies` land with no caller.
*Verify:* `bun run proxies` lists nothing; the editor is unchanged.
*Back out:* revert; the columns are inert.

**Phase 1 — worker stage and route, UI hidden** behind a `FEATURES` flag, the
pattern `showHookScore` already uses.
*Verify on the real box:* build a **short** video first, confirm three objects
appear and six columns are written; then the **3h41m outlier**, the worst case
for both encode time and queue blocking. Watch `worker-check.sh` during it.
*Back out:* flag stays off; assets are inert.

**Phase 2 — editor UI.** Overview timeline, unpinned window, wait state.
*Verify:* place a window at ~47 minutes of a long video, trim to 20 seconds,
save, and confirm the new clip renders that exact range.

**Phase 3 — flip the flag.** Then force a pass with `proxies --sweep` against a
deliberately small `PROXY_BUDGET_GB`, watch an eviction happen, and **confirm
the evicted video rebuilds on next open**.
*Back out:* flag off. Proxies stay bounded by retention regardless.

## 11. Open questions

None. The three forks that would have changed the design (§3) were settled
before it was written.
