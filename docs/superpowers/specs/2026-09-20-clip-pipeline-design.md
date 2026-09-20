# Clip Pipeline — Design Spec

**Date:** 2026-09-20
**Status:** Approved, implementing
**Scope:** Tier A — core pipeline (`new → setup → processing → results → download`)

---

## 1. Problem

`frontend/` is a complete, self-contained clickable prototype. It makes **zero
network calls**: every value comes from `src/data/fixtures.ts`, persistence is
`localStorage`, and job progress is a `setInterval` that adds 2.5% every 180ms
until it reaches 100 in about 7 seconds. Clips are materialised instantly at job
start via `CLIPS.slice(0, count)`, so the progress bar is theatre.

The prototype's own code documents the gap. `lib/persist.ts` rewrites a restored
`screen: 'processing'` back to `'new'` with the comment *"A half-finished job
can't resume — its timer died with the last page."* Making jobs server-side and
resumable is the core of this work.

Separately, `/home/wildandev/repo/clipper` holds a working shell pipeline
(download, cut, vertical reframe) that has never been wired end to end with
transcription or AI range selection, and has no subtitle burn-in at all.

This spec covers building a backend and worker that make the prototype real.

## 2. Scope

**In (Tier A):**

- URL analysis, job creation, real async processing with real progress
- Download → transcribe → AI range selection → cut → 9:16 reframe → burn
  subtitles → upload
- Results browsing, per-clip re-cut, single and bulk download
- Server-side projects that survive a page reload
- Shared-secret API token

**Out (deferred to Tier C):**

- Real auth, user accounts, per-user data isolation
- Quota enforcement and billing surfaces
- The editor screen — it stays on fixtures, visibly marked as prototype.
  Making it real needs range-request media serving, generated filmstrip
  thumbnails and a real waveform; none of that is on the critical path.

## 3. Hardware constraints

Verified on the target box, 2026-09-20:

| Resource | Value | Consequence |
|---|---|---|
| CPU | 4 cores, no GPU | Worker concurrency 1. Whisper `base` default. |
| RAM | 7GB total, ~4GB available | Stages must not overlap. MediaPipe is the peak. |
| Disk | 14GB free | **The binding constraint.** Needs a preflight guard. |

Whisper on 4 threads, `int8`, VAD filter, per hour of audio:

| Model | RAM | ~1h audio |
|---|---|---|
| `tiny` | ~200MB | ~5 min |
| **`base`** ← default | ~500MB | ~15–20 min |
| `small` | ~1GB | ~30–45 min |
| `medium`+ | ≥2.5GB | Not viable here |

`base` is the default because 4 cores makes `small` roughly twice as slow as
originally sized, and the transcript feeds an LLM that tolerates minor
transcription noise. `WHISPER_MODEL` overrides it.

**Disk guard:** before download, `ffprobe` the resolved format size via
`yt-dlp --dump-json`, and refuse the job when
`free_bytes < estimated_source × 3` (source + clips + renders). Failing fast
with a clear error beats filling the disk and wedging Postgres.

## 4. Architecture

```
frontend (vite :5173)  ──/api──►  backend (Bun + Hono :3004)
                                        │
                                   Postgres ──── pg-boss queue
                                        │              │
                                        └──────►  worker (Bun, concurrency 1)
                                                       │  shells out
                                                  yt-dlp · ffmpeg
                                                  whisper-ctranslate2
                                                  autocrop.py (venv)
                                                       │
                                                  MinIO / S3
```

The backend never touches media. It resolves URLs, writes rows, enqueues jobs
and streams progress. The worker does all CPU work. This split means restarting
the API does not kill a 40-minute transcription.

### 4.1 Queue: pg-boss on Postgres

Chosen over Redis/BullMQ and over a real broker (RabbitMQ/NATS/Kafka).

The workload is **long jobs at low throughput** — minutes per job, tens per day.
That is the profile where a broker's throughput advantage is worthless and its
operational surface is pure cost. Postgres `SKIP LOCKED` handles this ceiling
easily, and because the queue lives in the same database as the job rows, "job
claimed" and "job row updated" are transactional for free — the thing that is
genuinely fiddly with an external broker.

Postgres was already a hard requirement, so this adds **zero containers**.

Monitoring is SQL, not a dashboard: `scripts/queue-watch.sh` reports queue depth,
oldest waiting job, currently-active jobs with elapsed time, and recent failures.
The entire ops surface is four numbers; deploying bull-board to read them would
mean running a web service to query a table.

### 4.2 Storage split

**Source videos never go to S3.** A 2-hour VOD is multiple GB. Uploading it costs
money and buys nothing, because once the clips are cut the source is dead weight.

- Sources and intermediates → `WORK_DIR/<jobId>/`, **deleted on finalize**
- S3 holds only final artifacts: clip MP4s, thumbnails, transcript SRT

`infra/docker-compose.yml` runs MinIO locally; production points the same S3 env
vars at real S3.

## 5. Data model

```
videos      id, url, platform, title, duration_seconds, thumbnail_url,
            scratch_path (nulled on cleanup), created_at

jobs        id, video_id→videos, status, stage, progress(0-100), error,
            clip_count, length_preset, formats(jsonb), burn_subtitles,
            created_at, started_at, completed_at

transcripts id, video_id→videos, language, srt_key, segments(jsonb)

clips       id, job_id→jobs, idx, title, start_seconds, end_seconds,
            score, snippet, caption, subtitle_line, status

renders     id, clip_id→clips, ratio, s3_key, thumb_key,
            width, height, size_bytes, status
```

`jobs.status`: `pending | downloading | transcribing | analyzing | rendering |
completed | failed | cancelled`.

**Why `renders` is a separate table:** the setup screen lets a user tick 9:16
*and* 1:1 *and* 4:5. The prototype's `Clip` type has nowhere to put three files —
a gap that shows it was never wired to anything.

Transcripts key off `video_id`, not `job_id`, so a regenerate or a re-cut reuses
the existing transcript instead of paying for it twice.

No `users` table and no `user_id` column. Adding them later is an additive
migration; a stubbed fake user would have to be unpicked.

## 6. Pipeline

`analyze()` on the new-video screen is **synchronous** — `yt-dlp --dump-json`
returns title, duration and platform in a second or two without downloading. No
job required.

The job proper, with progress weights matching the existing 4-step UI in
`ProcessingScreen.tsx` (each step owns 24%):

| Stage | % | Work |
|---|---|---|
| `downloading` | 0→24 | `yt-dlp -f 'bv*[vcodec^=avc1]+ba[acodec^=mp4a]/b[ext=mp4]/bv*+ba/b'` |
| `transcribing` | 24→48 | `ffmpeg -vn -ac 1 -ar 16000` → `whisper-ctranslate2` |
| `analyzing` | 48→60 | OpenRouter → ranges, titles, scores, captions |
| `rendering` | 60→96 | per clip × ratio: cut → autocrop → burn subs → thumb → upload |
| `finalize` | 96→100 | delete scratch |

The yt-dlp format picker is inherited from `clipper/run.sh` and is load-bearing:
it forces H.264/AAC so that cuts stream-copy without re-encoding. YouTube's
default best is VP9/Opus, which lands in `.webm` and forces a re-encode per clip.

`yt-dlp` staleness is checked before each download (abort above 60 days).
YouTube rotates format-URL signing every few weeks; a stale build resolves the
title and then dies partway through with `HTTP Error 403`.

### 6.1 Progress reporting

The worker does `UPDATE jobs SET progress, stage`, then `pg_notify`. The backend
holds one `LISTEN` connection and fans out to SSE subscribers at
`GET /api/jobs/:id/events`.

No polling. Because progress lives in a table rather than in the queue, a browser
refresh mid-job resumes correctly.

### 6.2 AI range selection

OpenRouter, `google/gemini-2.5-flash`, configurable via `OPENROUTER_MODEL`.

Input is the **transcript with timestamps**, not the video. This sidesteps the
trap documented in clipper's unbuilt `cutlist.py` design: Gemini emits `MM:SS`
when shown a video, which is ambiguous past one hour and silently yields clips
past the end of the source. Because whisper already gave us segment timings, the
model returns float seconds against segments we supplied, and the ambiguity
cannot arise. Structured output via JSON schema, so parsing is not a regex
problem.

Validation before anything renders:

1. Clamp to `[0, duration]`
2. Enforce the length preset window (`<30s` / `30–60s` / `60–90s`)
3. Drop overlapping ranges, keeping the higher score
4. Snap boundaries to segment edges so clips do not start mid-word
5. Take the top N by score

A model that returns garbage must fail the job with a clear error, never produce
clips outside the source.

### 6.3 Subtitle burn-in

Net-new — clipper has none. Grepping it for `subtitles=`, `force_style`,
`drawtext` and `.ass` returns zero hits.

Per clip, build an SRT from the transcript segments in range with timestamps
shifted to clip-relative, then burn it **inside `autocrop.py`'s existing filter
chain**, after the scale:

```
sendcmd → crop=W:ih:x:0 → scale=1080:1920 → subtitles=clip.srt:force_style=… → setsar=1
```

A separate ffmpeg pass would mean a second full re-encode — double the render
time and a generation of quality loss — purely to add text.

`ClipSeed.line`, the pre-wrapped two-line hook shown on result cards, comes from
the AI stage and is independent of the burned track.

### 6.4 Vertical reframe

`autocrop.py` is vendored from clipper into `worker/python/` and patched for
subtitle burn-in. It uses MediaPipe face landmarks plus mouth-motion plus audio
RMS to pick the active speaker, then drives `crop x` over time through an ffmpeg
`sendcmd` file.

Python is not a new dependency: `whisper-ctranslate2` is also a Python CLI, so
the venv exists regardless. The worker shells out to CLI binaries uniformly —
`yt-dlp`, `ffmpeg`, `whisper-ctranslate2`, `autocrop.py` — and Python is an
implementation detail of two of them.

Porting gotchas carried over from clipper:

- `-ss` goes **before** `-i` (fast seek); `-t` not `-to`, whose semantics differ
  with a pre-input `-ss`
- The `sendcmd` timeline is in analysis-fps time (`i / analysis_fps`),
  independent of source fps
- Audio is mapped `0:a?` (optional) so silent clips do not fail the encode
- The `sendcmd` temp path is interpolated into a filter string; ffmpeg's
  filtergraph parser is fragile around `'`, `:` and `,` — keep the path clean

## 7. API

```
POST   /api/sources/analyze    {url} → {videoId, platform, title, duration, meta, eta}
POST   /api/jobs               {videoId, count, lengthIdx, formats, subs} → {jobId}
GET    /api/jobs/:id           → job + clips + renders
GET    /api/jobs/:id/events    → SSE {stage, progress, status}
POST   /api/jobs/:id/cancel
POST   /api/jobs/:id/regenerate
GET    /api/projects           → completed jobs, newest first
POST   /api/clips/:id/redo     → re-cut one clip
GET    /api/clips/:id/download → 302 to presigned URL
POST   /api/downloads          {clipIds} → streamed zip
```

Served under `/api` on port 3004, matching `deploy/nginx/clip2.mhamzah.id`.
(The rest of that vhost — `/users`, `/streams`, `/communities`, `/hls` — belongs
to a different product and should be ignored.)

### 7.1 Auth

A single shared secret. `API_TOKEN` in the environment, one Hono middleware
comparing it in constant time, one header on the frontend client.

This exists because `POST /api/jobs` is otherwise an unauthenticated "download an
arbitrary URL and burn every core for 40 minutes" endpoint. Exposed at
`clip2.mhamzah.id`, that hands a stranger free compute, bandwidth and storage,
and lets them wedge the box. That is a worse exposure than ordinary data leakage
because it costs money and availability.

It is a gate, not identity: everyone with the token shares one pool of projects.
Real per-user isolation is Tier C.

## 8. Frontend changes

`useSnipline.ts` keeps its shape — same screens, same callbacks — but the
timer-based `runJob` is replaced by a real `POST` plus an SSE subscription, and
the app stops importing fixtures.

Type changes forced by reality:

- `Clip.id`: `number` → `string` (uuid). The ordinal was only ever an array index
  (`CLIPS.slice(0,n).map((c,i) => ({...c, id: i}))`).
- `Clip` gains `renders: Record<Ratio, {url, thumbUrl}>` — the format tabs need
  somewhere to point.
- `Source` gains `durationSeconds: number`; `length` and `eta` become derived
  display strings rather than the only representation.
- `Project` carries `Source` inline instead of the `'stream' | 'podcast'` key,
  which is a lookup into the fixtures object and cannot represent a real project.

`VITE_API_URL` and `VITE_API_TOKEN` are introduced; the app currently references
no environment variables at all.

## 9. Testing

Deliberately light, to respect the box.

**Unit** (`bun test`, no media, runs by default):

- Range validation: clamping, length-window enforcement, overlap dropping,
  segment snapping
- SRT building and clip-relative time shifting
- Slugify (must match clipper's rule — the web UI reverses it)
- Progress arithmetic across stage weights
- OpenRouter response parsing against a recorded fixture

**Integration** (opt-in behind `RUN_MEDIA_TESTS=1`):

One bundled ~10-second fixture through download-skip → whisper `tiny` → cut →
render. Under a minute, well under 1GB peak.

Nothing in the default path downloads a real video or runs a real model.

## 10. Risks

| Risk | Mitigation |
|---|---|
| **Disk exhaustion** — 14GB free, VODs are GB-scale | Preflight guard at 3× estimated size; scratch deleted on finalize, including on failure |
| MediaPipe RAM on a 4GB-available box | Concurrency 1; autocrop falls back to static centre crop on failure rather than failing the job |
| yt-dlp staleness → mid-download 403 | Age gate before download, actionable error message |
| LLM returns invalid ranges | Validate-then-render; never render an unvalidated range |
| Long jobs vs. HTTP timeouts | All media work is in the worker; SSE carries progress; no long-lived request |
| OpenRouter unavailable | Job fails with a clear stage error; transcript is retained so a retry skips re-transcription |

## 11. Deferred

- Editor screen (real playback, filmstrip thumbnails, waveform, re-render on save)
- Real auth, user accounts, per-user isolation
- Quota enforcement, billing
- Caption rewriting via LLM
- Live stream capture (`ds.sh` — Kick/Twitch)

## 12. Unrelated security findings

Surfaced during exploration, not part of this work:

1. **`references/notes.md` is tracked in git and contains a live-looking
   `ANTHROPIC_AUTH_TOKEN`.** It is in commit history, so deleting the file is not
   sufficient — rotate the key.
2. `clipper/.env` holds live-looking Google OAuth credentials. Correctly
   gitignored and untracked, so not leaked to git, but worth rotating.
