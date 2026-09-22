# Saving an edit: unstick the job, and keep the original clip

2026-09-22

Two problems, found together. Saving an edit is refused outright on projects
where "Regenerate this clip" has ever been pressed; and when it does work it
overwrites the clip rather than producing a new one.

## 1. Why saving is refused

`recutClip` never writes the job's status back.

1. A project sits at `status: 'completed'`.
2. "Regenerate this clip" calls `/clips/:id/redo` → `recutClip` →
   `ensureDownloaded` → `setStatus(jobId, { status: 'downloading' })`.
3. `recutClip` returns. Its only `setStatus` writes to the **clips** table; the
   job row is never restored.
4. The job is stuck at `'downloading'` permanently.

Every write path then refuses it, because each one guards on the same thing:

| route | guard |
|---|---|
| `PATCH /api/clips/:id` | `clips.ts:179` |
| `POST /api/clips/:id/redo` | `clips.ts:147` |
| `POST /api/jobs/:id/assets` | `jobs.ts:248` |

which surfaces as the toast **"Wait for the job to finish before editing."**

The `quiet` option added on 2026-09-22 stops this happening again, but it cannot
repair a row already corrupted — and those rows never recover on their own.

### 1.1 A second way to get stuck

A worker killed mid-job leaves its row non-terminal with nothing running it.
Restarting `clip-worker` — which the editor-preview work required — does exactly
that to any job in flight at the time. Same symptom, different cause.

### 1.2 The repair

One reconciler at API startup, because both cases are decidable from the row:

```
completed_at IS NOT NULL and status is non-terminal  -> 'completed'
completed_at IS NULL and status is non-terminal
  and started_at older than the queue's expiry       -> 'failed'
otherwise                                            -> leave alone
```

The first rule is exact rather than heuristic: `completed_at` is only ever
written on a terminal transition, so a row carrying one alongside a non-terminal
status was corrupted by this bug and nothing else.

The second is grounded in `sendOptions.expireInHours = 6`: past that, pg-boss
has expired the queue entry, so no worker can ever pick the job up. Marking it
failed is what lets the user regenerate it instead of watching it forever.

The decision is a pure function over the row so it can be tested without a
database; only the `UPDATE` touches Postgres.

## 2. Saving as a new clip

Today the editor writes the new range onto the clip and re-renders it, so the
original cut is destroyed. The intent is the opposite: the edit is a **new**
clip, and the one it came from stays in the grid.

`POST /api/clips/:id/copy` with `{ s, e }`:

- validates the range with the existing `trimError`,
- refuses when the owner is out of storage, reusing `quotaVerdict`'s storage
  branch — a copy adds renders, and nothing else would bound how many,
- inserts a new `clips` row in the same job at `max(idx) + 1`, so it lands at
  the end of the grid rather than renumbering anything,
- carries the source clip's title, score, snippet, caption and subtitle line
  over: it is the same moment, retrimmed, and re-deriving them would need the
  model,
- enqueues the existing recut for the **new** id.

`recutClip` needs no changes. It renders whatever range is on the row it is
given, and its "delete previous renders" step is a no-op for a row that has
none.

`PATCH /api/clips/:id` is removed. Nothing calls it once the editor saves a
copy, and an endpoint whose whole purpose is to overwrite a clip in place is
not something to leave loaded. `trimError` stays — the copy route needs it.

## 3. Frontend

`saveTrim` becomes "save a copy": it posts the range, polls the **new** clip id
until it settles, then downloads it. The button says "Save as new clip", and the
toast names what happened rather than implying the original changed.

The editor stays open on the clip you were editing. The new one appears in the
grid behind it, which is where you would go looking for it.

## 4. Testing

- `backend` — `reconcileVerdict` as a pure function: a polluted row becomes
  completed, a stale orphan becomes failed, a genuinely running job and every
  already-terminal row are left alone.
- `backend` — `trimError` still gates the copy route (already covered).
- `backend` — `nextIdxFor` appends after the highest existing idx rather than
  counting rows, so a project with a deleted clip cannot hand the copy an idx a
  survivor already owns (idx names the file inside a download zip).

Not covered by a test: that `saveTrim` follows the returned copy id rather than
the edited one. Exercising it needs a React hook renderer, and the project has
none — its frontend tests render to static markup. It is enforced by the types
(`copyClip` answers the new clip) and by review.

## 5. Out of scope

- Renaming a copy, or editing its title. It inherits the original's.
- Any change to `.github/workflows`. The worker restart remains manual, and
  §1.1 is now survivable rather than permanent.
