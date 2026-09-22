# The editor should show why it will not save

2026-09-22

Clicking "Save as new clip" answers "Wait for the job to finish before editing."
and there is nothing on screen to wait for. Two independent faults.

## 1. The editor has no progress display at all

`App.tsx` renders the editor **outside** `AppShell`:

```tsx
{state.screen === 'editor' && <EditorScreen />}
{APP_SCREENS.includes(state.screen) && (
  <AppShell>…</AppShell>
)}
```

`AppShell` is what carries `JobIndicator`, in both its `nav` and `banner`
shapes. The editor deliberately renders without the shell — it owns the whole
viewport — and so it inherited no indicator. The job's status, stage and
percentage are all already in `SnipState`; the editor simply never rendered
them.

So the refusal is accurate and the thing it refers to is invisible.

### 1.1 The state is also stale

`watchJob` subscribes over SSE only for a job this session started or found
running at boot. Opening a project from the grid calls `refreshJob` once and
never again, so a job that changes state while the editor is open never updates
the screen.

## 2. The orphan rule was put where it cannot be decided

The 2026-09-22 reconciler restores a job whose `completed_at` is set but whose
status is non-terminal — exact, and it fixes the "Regenerate this clip"
pollution. It also tries to fail *orphans*: jobs killed mid-run, which carry no
`completed_at`. For those it waits `expireInHours` (6h) before acting.

That timeout exists only because it runs in the **API**, which has no way to
know whether a worker is currently running a job. It is the wrong home for the
rule. A job killed by a worker restart — which the editor-preview work
required — therefore stays stuck, unsaveable and invisible, for six hours.

The **worker** can decide it exactly. `deploy.sh` refuses to start when a second
worker exists ("Two workers share one queue and race for jobs"), so a single
worker is an enforced invariant — and a worker that is *starting up* is not
running anything. Every job still claiming to be mid-flight at that moment is
therefore orphaned, with no timeout needed.

### 2.1 The shape

`reconcileVerdict` loses its time heuristic and gains an explicit claim about
the caller's knowledge:

```ts
reconcileVerdict(job, { nothingIsRunning: boolean }): 'completed' | 'failed' | null
```

- already terminal → `null`
- `completed_at` set → `'completed'` (the work demonstrably finished)
- `nothingIsRunning` → `'failed'` (nobody can still be working on it)
- otherwise → `null`

The API calls it with `nothingIsRunning: false`, because it cannot know. The
worker calls it with `true` at startup, because it can. The pure function moves
to `shared/` so both sides decide identically; each keeps its own small query,
since `db` differs between them.

## 3. What the editor shows

- The `JobIndicator` banner, above the header, whenever the job is not
  completed. It is the existing prop-driven component fed by the existing
  `jobIndicator` derivation, so the editor cannot disagree with the sidebar
  about what is happening.
- "Save as new clip" and "Regenerate this clip" disabled while the job is not
  completed, with the reason inline next to them rather than as a toast fired
  after a click that was never going to work.
- While the job is non-terminal, the editor re-fetches it every few seconds so
  the banner advances and the buttons re-enable by themselves.

## 4. Testing

- `shared` — `reconcileVerdict` under both claims: that a running-looking job is
  left alone when the caller cannot know, and failed when it can; that
  `completed_at` still wins; that terminal rows are never touched.
- `frontend` — the editor renders the indicator and disables saving when the job
  is not completed, and does neither when it is.

## 5. Out of scope

- Moving the editor inside `AppShell`. It owns the viewport by design, and the
  banner is the part that was missing, not the sidebar.
- Any change to `.github/workflows`.
