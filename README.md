# Clip

Turns a long video into short vertical clips: download → transcribe → pick the
interesting moments with an LLM → cut → reframe to 9:16 following the speaker →
burn in subtitles.

```
frontend (vite :5173)  ──/api──►  backend (Bun + Hono :3014)
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

The backend never touches media — it resolves URLs, writes rows, enqueues jobs
and streams progress over SSE. The worker does all CPU work. Restarting the API
does not kill a running transcription.

Design notes: [`docs/superpowers/specs/2026-09-20-clip-pipeline-design.md`](docs/superpowers/specs/2026-09-20-clip-pipeline-design.md).

## Setup

**Prerequisites:** Bun, Docker, ffmpeg, yt-dlp, python3.

```bash
cp .env.example .env
```

Then fill in two values in `.env`:

| Variable | How |
|---|---|
| `API_TOKEN` | `openssl rand -hex 32` |
| `OPENROUTER_API_KEY` | https://openrouter.ai/keys |

```bash
bun install
bun run infra:up          # Postgres + MinIO
bun run db:migrate

./scripts/setup-python.sh # whisper-ctranslate2 + MediaPipe (~400MB of wheels)
```

Point the frontend at the API:

```bash
cp frontend/.env.example frontend/.env.local
# set VITE_API_TOKEN to the same value as API_TOKEN
```

## Run

Three terminals:

```bash
export PATH="$PWD/worker/.venv/bin:$PATH"   # worker terminal only

bun run dev:api
bun run dev:worker
bun run dev:web
```

## Monitor

```bash
./scripts/queue-watch.sh        # live dashboard
./scripts/queue-watch.sh once   # one snapshot
```

Reports queue depth, the oldest waiting job, what is running right now with
elapsed time, and recent failures. That is the whole ops surface — a stuck job
shows as a growing `running_for`, a backlog as a climbing `oldest`, a crashloop
as repeated failure rows.

## Test

```bash
bun test shared worker          # unit: no media, no model, no network
bun --cwd frontend run test

# Opt-in, needs infra up. Generates a 12s fixture; ~10s, no downloads.
cd worker && RUN_MEDIA_TESTS=1 bun --env-file=../.env test render.integration
```

## Configuration worth knowing

| Variable | Default | Notes |
|---|---|---|
| `WHISPER_MODEL` | `base` | `tiny`/`base`/`small`. On 4 CPU cores, `small` is roughly twice as slow as `base` for a transcript that only feeds an LLM. `medium`+ is not viable. |
| `WORKER_CONCURRENCY` | `1` | Whisper and x264 each want every core. Overlapping jobs make both slower and risk the OOM killer. |
| `MIN_FREE_DISK_GB` | `5` | Jobs are refused unless free disk is above this **and** 3× the estimated source size. |
| `YTDLP_MAX_AGE_DAYS` | `60` | YouTube rotates URL signing; a stale yt-dlp 403s partway through a multi-GB download. |
| `PUBLIC_API_URL` | `http://localhost:3014` | Signed media URLs are built against this. Wrong value = links the browser cannot reach. |

## How things work

**Queue.** pg-boss on the Postgres you already run — no Redis, no broker. The
workload is long jobs at low throughput (minutes each, tens per day), where a
broker's throughput buys nothing and its operational surface costs real time.
Queue and job rows sharing a database also makes "claimed" and "updated"
transactional for free.

**Storage.** Source videos never reach S3 — a 2-hour VOD is multiple GB and is
dead weight once cut. Sources and intermediates live in `WORK_DIR/<jobId>/` and
are deleted on every exit path, including failures. S3 holds only the rendered
clips, their thumbnails, and the transcript SRT.

**Range selection.** The model sees the *transcript with timestamps*, never the
video. Shown a video, Gemini emits `MM:SS`, which is ambiguous past one hour and
silently produces clips past the end of the source. Working from segments we
supplied, it returns float seconds and the ambiguity cannot arise. Every range is
then clamped, snapped to speech boundaries, length-checked and de-overlapped
before anything renders — see `worker/src/ranges.ts`.

**Subtitles.** Burned inside `autocrop.py`'s existing filter chain, after the
scale. A second ffmpeg pass would double the render time and cost a generation
of quality purely to add text.

**Media URLs.** MinIO is bound to localhost, so a presigned S3 URL would name a
host the browser cannot reach — and the signature is host-bound, so it cannot be
rewritten. Instead the API serves media at `/api/media/...` behind its own HMAC
signature, which also works from `<img>` and `<a download>` (neither can send an
`Authorization` header) and grants one object for a few hours rather than the
whole API.

## Auth

A single shared secret in `API_TOKEN`, required on every `/api` route. It exists
because `POST /api/jobs` is otherwise an unauthenticated "download an arbitrary
URL and burn every core for 40 minutes" endpoint — free compute, bandwidth and
storage for anyone who finds it.

It is a gate, not identity: everyone with the token shares one pool of projects.
Real accounts, per-user isolation and quota enforcement are deliberately out of
scope for now.

## Not built yet

- **The editor screen** is still the original prototype — fixture data, no real
  playback. Making it real needs range-request media serving, generated filmstrip
  thumbnails and a real waveform.
- Real auth, user accounts, quota enforcement
- Caption rewriting
- Live stream capture

## Ports

This box already runs other projects, so the defaults avoid the usual ones:
API `3014`, Postgres `5445`, MinIO `9020`/`9021` (all bound to localhost).
Note `deploy/nginx/clip2.mhamzah.id` proxies to `3004`, which is held by a
different service — update the vhost or change `PORT` before deploying.
