# Pluggable Storage Backends — Design Spec

**Date:** 2026-09-21
**Status:** Awaiting review
**Scope:** Object storage becomes a list of backends instead of one, so real S3
can be added without retiring the existing MinIO.

---

## 1. Problem

Every rendered clip, thumbnail and transcript SRT currently goes to **local
MinIO**, not S3. The deployed `.env` sets `S3_ENDPOINT=http://localhost:9020`,
which is the container from `infra/docker-compose.yml`, bound to `127.0.0.1`.
The `clip_miniodata` volume holds ~841 MB across four accounts.

The code is already endpoint-agnostic — `makeS3()` in `shared/s3.ts` takes
endpoint, region and path-style as arguments — so repointing the whole app at
AWS is a config change. But that is all-or-nothing: the moment `S3_ENDPOINT`
changes, every object already in MinIO becomes unreachable, because the single
client no longer knows how to reach the host holding them.

What is wanted instead: **add** a storage rather than replace one. New uploads
go to the newly added backend; everything previously written keeps serving from
wherever it was written; and the same move can be repeated for a third and
fourth backend later without touching code.

Storage is only ever written by the worker (three call sites) and only ever read
by the API (three call sites), so the surface is small and well bounded.

## 2. Scope

**In:**

- A registry of storage backends, with exactly one active write target
- Per-object routing recorded on the row that owns the key
- A resolver both services use to get the right client for a given object
- A management script: list, add, verify, activate, remove
- A non-breaking rollout: day one changes no `.env` value and no behaviour

**Out:**

- Migrating existing objects between backends. Old backends are **read-only
  forever**; there is no drain command and no lazy relocation. (Decided
  explicitly; see §3.)
- Presigned URLs. Delivery keeps proxying bytes through the API exactly as it
  does today. (Decided explicitly; see §3.)
- Credentials in the database, in any form, encrypted or otherwise (§3).
- Per-user or per-region storage routing. One active target, globally.

## 3. Decisions taken before designing

Three forks were settled with the user up front, because each one changes the
weight of everything downstream.

**Old backends are read-only forever.** MinIO keeps serving its existing objects
indefinitely and never receives another write. No migration tooling exists, which
removes an entire category of code (copy, verify, repoint, resume a half-finished
move). The accepted cost: a backend can never be fully switched off, so the MinIO
container must keep running for as long as clips written to it still exist.

**Delivery keeps proxying, even from real S3.** `media.ts` and the bulk-download
route continue to stream bytes through the API rather than redirecting to
presigned URLs. This keeps the per-user ownership check on every single byte and
means the media path — HMAC verification, session check, range handling, 206/416,
`Content-Disposition` — is not touched at all. The accepted cost: AWS egress to
the box **plus** the box's bandwidth to the user for every clip watched, an extra
network hop of latency, and the bulk-download heap concern in `clips.ts:119`
stays as it is. `presign()` remains in `shared/s3.ts`, unused.

**Credentials stay out of Postgres.** The registry table holds routing only
(endpoint, region, bucket, path-style, active flag). Access and secret keys live
in `.env`, one pair per backend. This matches the existing posture of the
codebase — sessions store a SHA-256 of the token rather than the token, MinIO is
localhost-bound, media URLs are HMAC-signed — and keeps a `pg_dump` from carrying
object-storage credentials. The accepted cost: adding a backend requires one
`.env` edit and a process restart. Changing *which* backend is active requires
neither.

## 4. How a read finds its object

Three options were considered.

**Chosen — record the backend on the row.** Each row that owns object keys also
records which backend holds them. Reads consult a column they already loaded.

**Rejected — encode the backend in the key prefix.** Avoids a migration, except
existing keys have no prefix, so an "unprefixed means MinIO" rule is needed
anyway. That is the same default as a column, but implicit, unindexable, and it
bakes routing into a string.

**Rejected — probe each backend until one has the object.** No schema change at
all, but every read of an older object pays a failed lookup against the active
backend first — latency plus a billed request — and a genuinely missing object
becomes indistinguishable from a misconfigured backend. It degrades with every
backend added, which is precisely the operation this design exists to make
repeatable.

The column wins because it is the only one that does not get worse as the list
grows, and because it makes "what is each backend still holding" answerable in
SQL — which matters directly: the storage quota shipped earlier sums
`renders.size_bytes`, and that sum can now be grouped by backend.

## 5. Schema

One migration, additive only.

```sql
create table storage_backends (
  id          text primary key,           -- 'minio', 's3-jkt'; [a-z0-9-] only
  label       text not null,
  endpoint    text,                       -- null = real AWS
  region      text not null,
  bucket      text not null,
  path_style  boolean not null,           -- true for MinIO, false for AWS
  is_active   boolean not null default false,
  created_at  timestamptz not null default now()
);

-- Exactly one write target, enforced by the database rather than by the script.
create unique index storage_one_active on storage_backends (is_active)
  where is_active;

-- MUST precede the ALTERs below: the foreign key is validated against every
-- existing row the moment the column is added with default 'minio', so the
-- referenced row has to exist first or the migration fails on a non-empty table.
insert into storage_backends
  values ('minio', 'Local MinIO', 'http://localhost:9020', 'us-east-1',
          'clips', true, true, now());

alter table renders     add column storage text not null default 'minio'
  references storage_backends(id);
alter table transcripts add column storage text not null default 'minio'
  references storage_backends(id);
```

`renders` holds both `s3_key` and `thumb_key`, which `render.ts:118-119` uploads
together, so one column per row is correct rather than one per key.
`transcripts.srt_key` is the third and last key type in `shared/s3.ts`.

The foreign keys do real work: they make deleting a backend that still owns
objects impossible at the database level, so the management script's guard is not
the only thing preventing orphaned clips.

The `'minio'` default is a **literal, not a lookup of whatever is currently
active**. A row written before this feature existed came from MinIO; that is a
fact about history, not a guess. Every new row has its value written explicitly
by the worker, so the default only ever applies to pre-existing rows.

## 6. The resolver

New `shared/storage.ts`, built like `shared/s3.ts` already is — a factory with
injected dependencies, so it carries no env coupling and is testable without a
database or a network:

```ts
makeStorage({ db, credentials })   // credentials: (id) => { accessKey, secretKey } | null
```

The API and the worker each construct it once, with their own `db` handle and
their own env reader. It exposes three operations:

```ts
active(): Promise<{ id: string; s3: S3 }>          // the write target
get(id: string): Promise<S3>                        // a specific backend, for reads
deleteMany(items: { storage: string; key: string }[]): Promise<void>
```

**Caching.** Backend rows are cached with a 30-second TTL, so flipping
`is_active` reaches both processes without a restart — that is what makes
activation a command rather than a deploy. Clients are memoised per backend id
and keyed by a fingerprint of the row's connection fields (endpoint, region,
bucket, path-style); when a reload produces a different fingerprint the old
client is discarded rather than reused, so editing a backend's bucket cannot
leave a process writing to the previous one.

**Only the worker needs an active backend.** All three upload sites live in the
worker; the API only ever reads and deletes, and both of those route by the
row's own `storage` value. So a missing or broken *active* backend cannot take
the website down — it stops new jobs from rendering, which is the correct blast
radius. This distinction drives the startup behaviour below.

**Legacy fallback.** For backend id `'minio'` the credential lookup falls back to
`S3_ACCESS_KEY` / `S3_SECRET_KEY` when `STORAGE_MINIO_*` is absent. This is what
makes Phase 0 of the rollout require no `.env` change.

**Writes resolve once per job.** `processJob` calls `active()` once and passes
the id down through `RenderClipOptions` to every `renderClip` call and to the SRT
upload. Flipping the active backend mid-job then leaves that job entirely in one
backend rather than scattered across two. Scattered would still be *correct* —
each row records its own location — but needlessly confusing to debug later.

### Failure modes

| Situation | Behaviour |
|---|---|
| No active backend | `active()` throws `No active storage backend`; the message lands in `jobs.error`. **Reads keep working.** |
| Row points at a deleted backend | Impossible; the foreign key rejects the delete. |
| Credentials missing for the **active** backend | The **worker** exits at startup naming the exact env vars. Discovering this 40 minutes into a transcription is the failure `assertWhisperAvailable()` already exists to prevent. The **API** only warns — it never writes, and taking the site down over a write-target problem would be the wrong blast radius. |
| Credentials missing for an **inactive** backend | Warning in both processes, never death. Clips in that backend will not serve, but everything else proceeds; a retired backend must not be able to take the pipeline down. |
| Wrong keys, or bucket unreachable | Caught by `storage verify` at add time, not on first use. |
| Backend added while processes run | The row appears within 30 s; its credentials need a restart. The script says so explicitly. |

## 7. Call sites

Nine, all enumerated. Both read paths already `select()` whole rows, so `storage`
arrives with the row they were loading anyway — **no query rewrites on the read
path.**

**Writes — worker**

| Site | Change |
|---|---|
| `render.ts:118` mp4 upload | use the job's resolved backend |
| `render.ts:119` thumbnail upload | same backend |
| `render.ts:127` `.set({ s3Key, thumbKey, … })` | add `storage: opts.storageId`, in the same statement as the keys it describes, so a key and its location cannot disagree |
| `pipeline.ts:218` SRT upload | same job-level backend |
| `pipeline.ts` transcripts insert | add `storage: storageId` |

**Reads — API**

| Site | Change |
|---|---|
| `media.ts:153` ranged stream | `(await storage.get(render.storage)).getStream(key, range)` |
| `media.ts:164` full stream | same |
| `clips.ts:126` zip loop | `storage.get(r.storage)` per row; clients are memoised, so this is a map hit |

**Deletes — signature changes from `string[]` to `{ storage, key }[]`**

| Site | Change |
|---|---|
| `jobs.ts:333` `deleteJobArtifacts` | group by backend |
| `pipeline.ts:274` recut drops old renders | group by backend |
| `backend/scripts/users.ts` `--delete` | group by backend; its select gains `storage` |

This delete grouping is the highest-risk change in the spec. If a call site keeps
the flat `string[]` shape, MinIO's keys get sent to S3, `DeleteObjects` succeeds
against keys that do not exist there, and the operation reports success while the
real objects survive forever — with the database insisting they are gone and the
storage quota under-reporting. It fails silently and permanently.

**Retiring:** the `s3` singletons in `backend/src/s3.ts` and `worker/src/db.ts`
become `storage`. **`shared/s3.ts` is not modified** — `makeS3` stays as it is and
the resolver builds on top of it.

**Untouched:** the `keys` layout, `presign`, the media HMAC, range parsing, and
the quota's `sum(renders.size_bytes)`.

## 8. Management script

`backend/scripts/storage.ts`, following the conventions of `quota.ts` and
`users.ts`: a pure `parseArgs` tested on its own, dynamic imports so arg parsing
works without an environment, destructive actions dry-run until confirmed.

```
bun run storage                        # list every backend
bun run storage add <id> --bucket B --region R [--endpoint URL] [--path-style] [--label "..."]
bun run storage verify <id>            # real round-trip against the bucket
bun run storage activate <id>          # change the write target
bun run storage remove <id> --yes      # delete a backend row
```

**list** (default) prints per backend: id, label, bucket, endpoint, active
marker, objects held (count across `renders` and `transcripts`), bytes held
(`sum(size_bytes)`), and whether credentials are present in the environment —
`present` / `MISSING`, never the value.

**add** inserts with `is_active = false`. Adding a storage must never silently
redirect production writes. The id is restricted to `[a-z0-9-]` because it
derives env var names deterministically (`s3-jkt` →
`STORAGE_S3_JKT_ACCESS_KEY` / `STORAGE_S3_JKT_SECRET_KEY`); the script prints
those two exact lines rather than leaving the transformation to be inferred,
followed by the ordered next steps (paste, restart, verify, activate).
Credentials cannot exist at add time, so `add` deliberately does not verify.

**verify** uploads a small object to `healthcheck/<uuid>`, reads it back,
compares bytes, deletes it, and reports **put / get / delete separately** — a
bucket policy that permits put but not delete looks healthy until project
deletion starts orphaning objects.

**activate** runs `verify` first and refuses on failure, then flips inside one
transaction (clear the old flag, set the new one). Prints that the change reaches
both processes within 30 seconds with no restart.

**remove** refuses if the backend is active; refuses if any row references it,
reporting real numbers (`minio still holds N objects (841 MB)`) rather than
surfacing a foreign-key error; and stays a dry run without `--yes`. Given
read-only-forever, this command is realistically for a backend added with a typo
and never written to, and its help text says exactly that.

No command ever prints a secret value.

## 9. Rollout

**Phase 0 — plumbing, no behaviour change.** Migration, resolver, converted call
sites, script. `.env` untouched; `'minio'` uses the legacy fallback.
*Verify:* `bun run storage` shows MinIO active holding ~841 MB; an existing clip
plays; a fresh job renders and its rows say `'minio'`.
*Back out:* revert the deploy. The migration is additive, so the table and
columns can stay in place — older code ignores them. No down-migration.

**Phase 1 — add S3, do not activate.** Create the bucket and an IAM user scoped
to `PutObject`/`GetObject`/`DeleteObject` on that bucket only. `storage add`,
paste env, restart, `storage verify`.
*Verify:* put/get/delete each report OK while production still writes to MinIO.
*Back out:* `storage remove <id> --yes`; zero rows reference it.

**Phase 2 — activate.** `storage activate <id>`; effective within 30 s, no
redeploy.
*Verify:* one job end to end — rows carry the new backend id, objects appear in
the S3 console, the clip plays in the browser (proving the proxy read path
resolves the new backend), **and an old clip still plays** (proving MinIO still
resolves). The last check is the point of the whole design.
*Back out:* `storage activate minio`. Instant. Objects already written to S3 keep
their rows pointing at S3 and keep working — activation is reversible at any
moment with zero data movement.

**Phase 3 — steady state.** The MinIO container stays up for as long as objects
written to it exist. `bun run storage` reports how much is parked there.

**Operational note:** deploy while the queue is idle (`scripts/queue-watch.sh`).
A worker restart mid-job meets a pre-existing gap — `boss.stop` waits 30 s, then
the job's row sits at `rendering` forever under `retryLimit: 0`. Unrelated to
this change, but this deploy is a moment where it would be met.

## 10. Testing

**Unit, no Postgres and no network** (the resolver takes `db` and `credentials`
as arguments precisely so this is possible):

- picks the active backend
- throws a named error when no backend is active
- groups `deleteMany` by backend into one batched call each
- falls back to legacy `S3_ACCESS_KEY` for `'minio'`
- refreshes after the TTL, and not before
- script `parseArgs`: each subcommand, unknown flags rejected, missing id
  rejected, `remove` without `--yes` stays a dry run, invalid id rejected at add
- the id → env-var derivation, as its own test: a silent mismatch there surfaces
  as "credentials missing" and sends the reader hunting in the wrong place

**Integration, opt-in behind `RUN_DB_TESTS=1`** (the pattern in
`projects.delete.integration.test.ts`):

- the migration backfills every pre-existing row to `'minio'`
- the foreign key refuses to drop a referenced backend
- the partial unique index refuses a second active backend

**Not automatable in this environment, and stated rather than implied:** there is
no AWS account and no browser here. `storage verify` is the substitute for the
first; the Phase 2 playback checks are the user's to run.

## 11. Open questions

None. The three forks that could have changed the design (§3) were settled before
it was written.
