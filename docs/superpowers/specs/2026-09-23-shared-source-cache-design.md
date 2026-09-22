# Shared Source Cache and Live Project Progress — Design Spec

**Date:** 2026-09-23
**Status:** Awaiting review
**Scope:** Stop re-downloading a source that is already on the worker's disk,
and let the projects list show what each job is doing while it does it.

---

## 1. Problem

Two complaints, one of which is a symptom of a deliberate decision and one of
which is nearly built already.

### 1.1 Saving a trim re-downloads the whole source

Opening manual mode downloads the source to build the full-length proxy
(`buildSourceProxy`). Saving a trim as a new clip, minutes later, downloads the
same file again (`recutClip`). On a four-hour 1080p video that is roughly 8GB
fetched twice for one editing session.

This is not an oversight. `ensureDownloaded` will only reuse
`videos.scratch_path` when `ownsScratch(path, workDir)` — when *this same
operation* did the downloading. `worker/src/scratch.ts` explains why:

> *"`videos.scratch_path` is a single global column, but the file it names
> lives inside ONE operation's scratch directory — and every exit path deletes
> that directory. [...] Reading it from a different operation is the race: a
> re-cut that adopted a running job's download lost it the moment that job
> finished and cleaned up, failing mid-render on a file it never created."*

So the guard is correct and must not simply be removed. The four worker
entry points run in different directories —

| operation | workDir |
|---|---|
| `processJob` | `job-<jobId>` |
| `backfillAssets` | `assets-<jobId>` |
| `recutClip` | `recut-<clipId>` |
| `buildSourceProxy` | `source-<videoId>` |

— so `ownsScratch` is false across every pair of them, and a download is
reusable by nobody but its creator. The manual-clipping spec accepted this and
said so in the UI copy: *"The source is re-downloaded, which usually takes a few
minutes."*

The fix is not to relax the guard but to remove the thing it guards against:
put the download somewhere **no operation owns and no operation deletes.**

### 1.2 The projects list does not show work in flight

A running job was visible only through the single global banner, which shows one
job — whichever this session last touched. Two concurrent jobs, or a job started
on another device, were invisible on the one screen that lists work.

This is already implemented in the working tree but uncommitted, and it has one
real gap: the bar does not move. `loadProjects()` runs at boot and on job
completion only, and the SSE subscription patches the banner's
`progress`/`stage`/`jobStatus`, never `state.projects`. Each row renders a
frozen snapshot.

## 2. Scope

**In:**

- A shared, host-scoped cache of downloaded sources, with ref-counting,
  TTL/budget eviction, and crash recovery.
- Removal of `videos.scratch_path` and `worker/src/scratch.ts`, which the cache
  supersedes.
- Live progress on the projects list, by polling.

**Out:**

- Worker concurrency. `boss.work` stays `batchSize: 1` per registration and pm2
  stays `instances: 1`. The cache makes overlapping operations *safe*; it does
  not create them.
- Caching sources across hosts, or any shared filesystem between workers. Each
  host caches for itself.
- A multi-job SSE stream. Considered and rejected in §3.3.
- Changing what `PROXY_BUDGET_GB` covers. Source proxies and source downloads
  are separate budgets on the same disk.

## 3. Decisions taken before designing

### 3.1 Multi-host must keep working

`ecosystem.config.cjs` pins pm2 to `instances: 1` and says *"NEVER raise this"*,
but `docker-compose.worker.yml` exists for *"standalone or multi-host
deployment"* and mounts a per-host `worker-work` volume. Multi-host is a
supported topology and the design must not quietly break it.

That single fact rules out the cheapest implementation. `video_source_cache.path`
is an absolute path on one machine's disk. If two hosts share one row, host B
reads a path that exists only on host A — and worse, host B's ref increment pins
a row that host A's sweep then refuses to evict forever.

**Decision: the cache is keyed `(video_id, host_id)`.** Rejected alternatives:

- *Five columns on `videos`, including `source_host`.* One row per video means
  only one host can record a cached copy. When host B claims the row it
  overwrites host A's path — and host A's multi-gigabyte file is now an orphan
  with nothing pointing at it, which no sweep can ever find. Fixing that needs a
  second, filesystem-level orphan sweep. Cheapest diff, worst invariant.
- *No database state; derive everything from the filesystem.* Genuinely simpler,
  and a lock-file-per-holder cannot drift the way a counter can. Rejected
  because "the disk is the scope" stops being true the moment you need to know
  *which* host holds a source, and because it would reshape the already-written
  and already-tested `sourceCache.ts` types.

### 3.2 A leaked lease is reclaimed by its own host at boot

A worker that dies mid-render (OOM, redeploy, `kill -9`) leaves `refs > 0`
forever. `sourceCache.ts` already documents the consequence: that row is never
evicted, at any size, by any rule. A couple of those fill the disk and every
subsequent download fails `assertDiskSpace`.

**Decision: each host zeroes its own leases at startup, and only its own.**

This is safe for exactly the reason `reconcileOnBoot` already gives for the
equivalent move on `jobs`: the worker has not claimed any work yet, so every
lease it holds was abandoned by a previous process. It needs no heartbeat, no
timer, and the `host_id` it keys on is required for §3.1 anyway.

Rejected: *lease expiry plus heartbeat* — most robust, and the only option that
survives a host that never comes back, but it threads a renewal through
`render` and `transcribe`, which are precisely the long, blocking calls.
Rejected: *fixed generous expiry without heartbeat* — a 4-hour source plus
whisper can outlive any window short enough to be useful, and losing the file
mid-render is the exact bug `ownsScratch` was written to stop.

A host that dies permanently leaks its disk. That is a machine somebody has to
deal with anyway, and `--sweep` exists for it.

### 3.3 Progress moves by polling, not by a new stream

**Decision: while the projects screen is open and anything is running, refetch
`/projects` every 3s.**

Rejected: *patch `state.projects` from the existing single-job SSE* — free, but
it only moves the one job this session is watching, leaving the second
concurrent job and anything started on another device frozen. That is the
original complaint, unfixed.
Rejected: *a per-user multi-job SSE stream* — genuinely live with no polling,
but it is a new endpoint plus `LISTEN` fan-out routing, which is more machinery
than a list that is only on screen sometimes deserves.

### 3.4 Sizing

`PROXY_BUDGET_GB` is 6 and its comment describes the box: *"~20GB free on a disk
shared with several other applications"*, with `MIN_FREE_DISK_GB` at 5. That
leaves roughly 9GB — and the same comment notes *"a four-hour 1080p source can
be an 8GB scratch download on its own."*

**Decision: `SOURCE_BUDGET_GB` = 8, `SOURCE_TTL_MINUTES` = 60.**

The TTL is in **minutes, not days**, unlike proxies. This cache exists to bridge
one editing session — open the editor, trim, save, trim again — not to act as a
library. Holding 8GB for a session that ended is pure waste on a disk that also
has to fit the next download.

## 4. Data model

### New table `video_source_cache`

| column | type | notes |
|---|---|---|
| `video_id` | fk → `videos.id`, `on delete cascade` | matches `jobs` and `transcripts` |
| `host_id` | `text not null` | which worker's disk holds it |
| `path` | `text not null` | absolute, on that host |
| `bytes` | `bigint not null` | from `stat()` after the rename, so it measures the file that is actually cached rather than yt-dlp's estimate. A full-res download; `integer` tops out at 2.1GB |
| `used_at` | `timestamptz not null default now()` | eviction order |
| `refs` | `integer not null default 0` | operations holding it open |

Primary key `(video_id, host_id)`. Index on `(host_id, used_at)` — every sweep
query is host-scoped and ordered by age.

`on delete cascade` would orphan a file if a `videos` row were hard-deleted.
Production never does: job deletion is soft (`jobs.deleted_at`), and the only
`db.delete(videos)` calls in the tree are integration-test teardown.

### Removed

- `videos.scratch_path`
- `worker/src/scratch.ts` and `worker/src/scratch.test.ts`. `ownsScratch` exists
  solely to make `scratch_path` safe; with the column gone it guards nothing.
- The three `set({ scratchPath: null })` calls in `pipeline.ts` (lines 405, 456,
  621).

### Migration

Migration `0008_green_ricochet` is **uncommitted**, so it is regenerated as this
table rather than the four `videos` columns it currently adds. Swapping it costs
nothing today and would be painful once applied anywhere real.

### `shared/sourceCache.ts`

Field renames only — `sourceBytes`/`sourceUsedAt`/`sourceRefs` become
`bytes`/`usedAt`/`refs`, and `id` carries the `video_id` (unique within a host,
since every sweep is host-scoped). The three eviction rules, their ordering, and
`sourceCache.test.ts` are untouched.

### New environment (worker)

```
SOURCE_BUDGET_GB   default 8
SOURCE_TTL_MINUTES default 60
WORKER_HOST_ID     default os.hostname()
```

## 5. Lifecycle

`ensureDownloaded` is replaced by `acquireSource`, returning a lease. The rename
is deliberate: the caller now has an obligation to release it, and keeping the
old name would hide that obligation at four call sites.

```ts
const lease = await acquireSource(jobId, video, { quiet })
try {
  // … use lease.path …
} finally {
  await lease.release()
}
```

The signature keeps `ensureDownloaded`'s: `jobId` stays `string | null`
(`buildSourceProxy` passes null, having no job to report against) and `quiet`
keeps its existing meaning — suppress the public status change, leave the
download and its disk guards alone.

### 5.1 Acquire

1. ```sql
   UPDATE video_source_cache
      SET refs = refs + 1, used_at = now()
    WHERE video_id = $1 AND host_id = $2
   RETURNING path
   ```
   The increment is atomic in SQL. The four `boss.work` registrations poll
   independently, so two operations on one source really can overlap, and a
   read-modify-write in application code could lose an update between them.

2. **Hit** — a row came back *and* `fileExists(path)`. Announce
   `'Using cached download'` at fraction 1 and return. **This is the fix for
   §1.1.**

3. **Stale row** — a row came back but the file is gone (volume wiped, manual
   delete). Delete the row, which discards the increment along with it, and fall
   through to download. The cache self-heals without a boot reconcile.

4. **Miss** — `sweepSources()` (see §6.2), then `assertYtdlpFresh`, `probe`,
   `assertDiskSpace`, then download, then insert:
   ```sql
   INSERT INTO video_source_cache (video_id, host_id, path, bytes, used_at, refs)
   VALUES ($1, $2, $3, $4, now(), 1)
   ON CONFLICT (video_id, host_id)
   DO UPDATE SET path = excluded.path, bytes = excluded.bytes,
                 used_at = now(), refs = video_source_cache.refs + 1
   ```

### 5.2 Where the download goes

`WORK_DIR/sources/<videoId>/source.<ext>`.

**Per-video subdirectory, not a flat directory.** `download()` hardcodes its
output template as `${outDir}/source.%(ext)s`, so two different videos
downloading into one shared directory would collide on the same filename. A
subdirectory per video avoids that with **no change to `download()`**.

**Downloaded to `<videoId>.partial/`, then `rename()`d to `<videoId>/` on
success.** `download()` passes `--no-part`, so yt-dlp writes straight to the
final name with no temporary suffix of its own — a worker killed mid-download
therefore leaves a **truncated `source.mp4` that looks complete**. For a
single-owner scratch directory that was harmless, because the directory was
deleted on the way out. For a shared cache it is fatal: the next operation would
reuse a truncated file and fail somewhere deep in ffmpeg.

Renaming a directory is atomic within one filesystem, and the row is inserted
only after the rename, so no reader can ever observe a partial download as
cacheable.

### 5.3 Release

```sql
UPDATE video_source_cache
   SET refs = refs - 1, used_at = now()
 WHERE video_id = $1 AND host_id = $2 AND refs > 0
```

The `refs > 0` guard stops a double-release driving the count negative. Belt and
braces: `sourceCache.ts`'s `inUse` already reads *any* non-zero value as in use,
so a drifted count fails safe toward "do not delete" in either direction.

### 5.4 Call sites

`processJob`, `backfillAssets`, `recutClip` and `buildSourceProxy` each wrap
their existing body in the lease and keep their `rm -rf workDir` in `finally`
exactly as it is.

That cleanup is now harmless, because **the source no longer lives in the
operation's workDir.** Relocating one file out of owned scratch and into an
unowned directory is the whole of the fix; everything else in this spec exists
to bound and reclaim it.

## 6. Eviction

`sweepSources()` joins `sweepSourceProxies()` in `worker/src/retention.ts` and
copies its shape exactly: `shared/sourceCache.ts` decides, this half touches the
world.

### 6.1 Rule

Read rows `where host_id = me`, feed them to `sourceEvictionPlan` with
`SOURCE_BUDGET_GB × 1024³` and `SOURCE_TTL_MINUTES`. Three rules in order, as
already written and tested: in-use is untouchable, then TTL, then budget by
least-recently-used.

For each eviction: `rm -rf dirname(path)` **first**, and delete the row **only
if that succeeded.** This is the rule `sweepSourceProxies` already states —
forgetting the path while the file survives creates an orphan that silently
holds budget no future sweep can release. A failed delete is logged and retried
next sweep.

### 6.2 When it runs

No cron. The same *"the operation that grows storage is the one that shrinks
it"* rule the proxy sweep uses, at three moments:

1. **At worker boot**, after the ref reset (§6.3).
2. **After every `lease.release()`**, wrapped in `.catch()` so a sweep failure
   can never fail the operation that just succeeded. With an 8GB budget and
   multi-gigabyte files, waiting for the next boot to reclaim is not an option.
3. **On a cache miss, before `assertDiskSpace`.** This one is load-bearing: it
   lets the budget actively make room for the incoming download instead of only
   tidying up afterwards. Without it the cache would *cause* disk-full failures
   rather than absorb them.

### 6.3 Boot sequence

In `worker/src/index.ts`, before any `boss.work` registration. The order is
load-bearing:

1. `UPDATE video_source_cache SET refs = 0 WHERE host_id = $me`, logging the
   count. A non-zero count means the previous process exited uncleanly, which is
   worth knowing.
2. `rm -rf WORK_DIR/sources/*.partial` — debris from a download killed in
   flight.
3. `sweepSources()`.

If the reset did not come first, the sweep would spare everything the dead
process had pinned, which is the whole failure this recovers from.

### 6.4 Operator control

`backend/scripts/proxies.ts` already has `--sweep`. It gains the source cache in
both its report and its sweep, so there is one hand-operated lever for both
caches rather than two half-remembered ones.

## 7. Live project progress

### 7.1 Already in the working tree

Uncommitted and kept as-is:

- `listProjects` includes non-terminal jobs (a running job has no clips yet, so
  requiring clips excluded it entirely), returns `status`/`stage`/`progress`,
  and orders by `coalesce(completedAt, createdAt)` so a job just started is not
  sorted below projects finished weeks ago.
- `ProjectProgress` in `ProjectsScreen.tsx` renders a `Meter` plus the activity
  label, reusing `jobIndicator` so a row and the banner describe the same job in
  the same words. Finished work renders nothing; failed work does.
- Finer-grained worker reporting (`Fetching captions`, `Captions ready`,
  `Choosing clips`) and corrected `STAGE_WEIGHTS` so a step no longer goes green
  while its stage is still running.

### 7.2 Making it move

A pure predicate in `derive.ts`, beside `quota` and `jobIndicator`:

```ts
export const anyProjectRunning = (ps: ProjectDTO[]) => ps.some((p) => !isTerminal(p.status))
```

Two effects in `useSnipline.ts`, deliberately separate:

- **On entering the projects screen** → `loadProjects()`. Today the list is
  fetched only when `state.user` changes, so starting a job and navigating to
  Projects shows a list that predates the job. This is worth fixing on its own,
  independently of polling.
- **While `screen === 'projects' && anyProjectRunning(projects)`** →
  `setInterval(loadProjects, 3000)`, cleared when the condition flips or on
  unmount.

The interval's dependency is that **boolean**, not `state.projects`. Depending
on the array would re-create the interval on every fetch — the fetch sets the
array, which restarts the effect, which fetches again. Gating on the boolean
creates the timer once when work starts and tears it down once when it ends.

Screen-gated because the list renders nowhere else. Since `isTerminal('failed')`
is true, a failed project stops the poll rather than spinning forever.

`ponytail:` fixed 3s interval, no backoff and no pause-on-hidden. Browsers
already throttle background intervals, and the existing tab-visibility handler
catches up on return. Add backoff if the request rate ever shows up in the API
logs.

## 8. Failure modes

| what happens | result |
|---|---|
| Killed mid-download | `.partial` directory, no row. Next acquire re-downloads; boot clears the debris. Never reused, because reuse is gated on the row and the row is written only after the rename. |
| Killed mid-render holding a lease | `refs` pinned, file spared — which is correct, the job may be retried. Cleared at that host's next boot (§6.3). |
| Volume wiped, rows survive | `fileExists` gate fails → row deleted, re-download. Self-healing (§5.1 step 3). |
| Two hosts, same video | Two rows, two downloads, each host reuses its own. No interference, no orphans. |
| Wrong or colliding `WORKER_HOST_ID` | Degrades to re-download, never to a missing file mid-render, because reuse requires `fileExists` as well as a host match. |
| Delete fails (permissions, EBUSY) | Row kept, logged, retried next sweep. |
| In-use rows alone exceed budget | `sourceEvictionPlan` reports `overBudgetBytes`; logged. The next download may still hit `assertDiskSpace`, which is the correct failure — it is a disk problem, not a cache bug. |

## 9. Testing

| test | where |
|---|---|
| `sourceEvictionPlan` — unchanged logic, renamed fields | `shared/sourceCache.test.ts` (exists) |
| `anyProjectRunning` — empty, all terminal, one running, failed-is-terminal | `frontend/src/lib/logic.test.ts` |
| Two concurrent acquires → `refs = 2`; one release → 1; double release stays ≥ 0 | new `worker/src/sourceCache.integration.test.ts` |
| Row present but file missing → row deleted, re-download taken | same |
| Sweep spares `refs > 0`; evicts by TTL then budget | same |
| Boot reset zeroes only the calling host's rows | same |

The lease tests run against a real Postgres, matching the existing
`*.integration.test.ts` convention rather than mocking SQL. The atomic increment
*is* the thing under test; a mock would assert nothing.

**The acceptance check that matters is manual:** open the editor, save a trim as
a new clip, and confirm the worker logs `Using cached download` rather than a
second `Downloading source`.

## 10. Rollout

1. `bun run db:generate` regenerates 0008. Anyone who already applied the
   current uncommitted 0008 locally needs `db:push` to reconcile.
2. `bun run db:migrate` **before** the new worker starts — `acquireSource`
   queries a table that would not otherwise exist.
3. Deploy API and worker together, as `ecosystem.config.cjs` already requires.
4. First boot logs the ref reset count (expected: 0) and the first
   `sweepSources()` (expected: nothing to evict).

Existing `videos.scratch_path` values point into workDirs that were deleted long
ago; the column is dropped, and nothing reads it in the new code.

## 11. Open questions

None. The three forks that would have changed the design — multi-host support,
leaked-lease recovery, and polling versus streaming — were settled in §3 before
it was written.
