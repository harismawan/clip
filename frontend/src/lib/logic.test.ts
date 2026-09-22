import { beforeEach, expect, test } from 'bun:test'
import { clampTrim, firstEnabled, mergeJob, needsCatchUp, restored } from '../state/useSnipline'
import type { SnipState } from '../state/useSnipline'
import type { JobSnapshot } from './api'
import { ago } from './format'
import { anyProjectRunning } from './derive'
import { savePersisted } from './persist'
import type { Persisted } from './persist'
import type { Clip, JobStatus, Source } from '../types'

const clip = (id: string, idx: number, selected = false): Clip => ({
  id,
  idx,
  selected,
  t: 'a moment',
  s: 100,
  e: 140,
  sc: 70,
  sn: '',
  cap: '',
  line: '',
  status: 'ready',
  proxyUrl: null,
  stripUrl: null,
  peaks: null,
  win: null,
  renders: {},
})

const source: Source = {
  videoId: 'v1',
  platform: 'YouTube',
  title: 'a stream',
  length: '45:12',
  durationSeconds: 2712,
  meta: 'chan · 1080p available',
  eta: '~3 min',
  thumbnailUrl: null,
}

const base = {
  trimIn: 20,
  trimOut: 60,
  jobId: 'job-1',
  source,
  clips: [clip('c0', 0)],
  projects: [],
} as unknown as SnipState

test('clampTrim keeps the window inside 0–100 and never inverts it', () => {
  expect(clampTrim(base, 'in', -50).trimIn).toBe(0)
  expect(clampTrim(base, 'out', 500).trimOut).toBe(100)
  // Pushing the in point past the out point stops a minimum span short of it.
  expect(clampTrim(base, 'in', 90).trimIn).toBe(56)
  expect(clampTrim(base, 'out', 5).trimOut).toBe(24)
  // It touches nothing but the handle it was asked about. The playhead used to
  // be dragged along here; it belongs to the video element now, and the editor
  // seeks that directly.
  expect(clampTrim(base, 'in', 30).trimOut).toBe(60)
  expect(clampTrim(base, 'out', 80).trimIn).toBe(20)
})

test('firstEnabled picks the leftmost rendered format', () => {
  expect(firstEnabled({ '9:16': false, '1:1': true, '4:5': true })).toBe('1:1')
  expect(firstEnabled({ '9:16': true, '1:1': true, '4:5': false })).toBe('9:16')
  // Nothing selected shouldn't leave the results tabs with no format at all.
  expect(firstEnabled({ '9:16': false, '1:1': false, '4:5': false })).toBe('9:16')
})

const snapshot = (over: Partial<JobSnapshot> = {}): JobSnapshot => ({
  id: 'job-1',
  status: 'completed',
  stage: 'Done',
  progress: 100,
  error: null,
  clipCount: 12,
  lengthIdx: 1,
  formats: { '9:16': true, '1:1': false, '4:5': false },
  subs: true,
  source,
  clips: [clip('c0', 0), clip('c1', 1), clip('c2', 2)],
  createdAt: '2026-09-20T10:00:00Z',
  completedAt: '2026-09-20T10:20:00Z',
  ...over,
})

test('mergeJob ticks the first two clips on a first load', () => {
  const next = mergeJob({ ...base, clips: [] }, snapshot())
  expect(next.clips.filter((c) => c.selected).map((c) => c.id)).toEqual(['c0', 'c1'])
})

test('mergeJob preserves the user’s selection across a refresh', () => {
  const withChoice = { ...base, clips: [clip('c0', 0, false), clip('c2', 2, true)] }
  const next = mergeJob(withChoice, snapshot())
  // c2 stays ticked, and the first-two default does not reassert itself.
  expect(next.clips.filter((c) => c.selected).map((c) => c.id)).toEqual(['c2'])
})

test('mergeJob opens the results tab on a format the job actually rendered', () => {
  const next = mergeJob(base, snapshot({ formats: { '9:16': false, '1:1': true, '4:5': false } }))
  expect(next.filter).toBe('1:1')
})

test('mergeJob carries job status through so the UI can react to a failure', () => {
  const next = mergeJob(base, snapshot({ status: 'failed', error: 'disk full', progress: 40 }))
  expect(next.jobStatus).toBe('failed')
  expect(next.jobError).toBe('disk full')
  expect(next.jobDone).toBe(false)
})

const saved = (over: Partial<Persisted>) =>
  savePersisted({
    jobId: 'job-1',
    count: 12,
    lengthIdx: 1,
    formats: { '9:16': true, '1:1': false, '4:5': false },
    subs: true,
    emailMe: true,
    screen: 'projects',
    ...over,
  })

beforeEach(() => {
  // This file used to import `vi` from vitest. vitest was a declared dependency,
  // but the suite runs under `bun test`, which substitutes its own `vi` shim --
  // and that shim has no stubGlobal, so all 12 tests here threw before reaching
  // an assertion. Defining the global directly needs no shim at all: persist.ts
  // only calls getItem/setItem, and each beforeEach installs a fresh store.
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  })
})

test('restored keeps a job in flight so it can be re-subscribed', () => {
  // Jobs live server-side now, so 'processing' survives a reload.
  saved({ screen: 'processing' })
  expect(restored().screen).toBe('processing')
  expect(restored().jobId).toBe('job-1')
})

test('restored backs off the clip screens when there is no job to fetch', () => {
  saved({ screen: 'results', jobId: '' })
  expect(restored().screen).toBe('new')

  saved({ screen: 'processing', jobId: '' })
  expect(restored().screen).toBe('new')
})

test('restored sends the editor back to the grid', () => {
  // The editor needs one clip in particular, which isn't persisted.
  saved({ screen: 'editor' })
  expect(restored().screen).toBe('results')
})

test('restored survives storage that is junk or unavailable', () => {
  localStorage.setItem('snipline.v2', '{not json')
  expect(restored()).toEqual({})

  localStorage.setItem('snipline.v2', '{"jobId":42,"screen":"projects"}')
  expect(restored().jobId).toBeUndefined()

  // Storage absent entirely, as in a locked-down browser.
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined })
  expect(restored()).toEqual({})
})

test('ago reads as a coarse relative time', () => {
  const now = Date.parse('2026-09-19T12:00:00Z')
  const minsAgo = (n: number) => ago(now - n * 60_000, now)
  expect(minsAgo(0)).toBe('just now')
  expect(minsAgo(5)).toBe('5 min ago')
  expect(minsAgo(60 * 3)).toBe('3h ago')
  expect(minsAgo(60 * 24)).toBe('yesterday')
  expect(minsAgo(60 * 24 * 6)).toBe('6 days ago')
})

test('mergeJob drops formats the job never rendered', () => {
  // The API sends ONLY the ratios it rendered -- routes/jobs.ts builds it as
  // Object.fromEntries(enabled.map(r => [r, true])), so absent means "not
  // rendered", never "false".
  const serverSent = { '9:16': true } as unknown as JobSnapshot['formats']
  // Local prefs from the setup screen, where 1:1 happens to be ticked.
  const local = { ...base, formats: { '9:16': true, '1:1': true, '4:5': false } }

  const next = mergeJob(local as SnipState, snapshot({ formats: serverSent }))

  // 1:1 must not survive: the results screen renders a tab per enabled format,
  // and a tab whose renders[ratio] is undefined shows every card as the hatch
  // placeholder instead of its thumbnail.
  expect(next.formats).toEqual({ '9:16': true, '1:1': false, '4:5': false })
})

test('mergeJob keeps every format a multi-ratio job did render', () => {
  const serverSent = { '9:16': true, '4:5': true } as unknown as JobSnapshot['formats']
  const next = mergeJob(base, snapshot({ formats: serverSent }))
  expect(next.formats).toEqual({ '9:16': true, '1:1': false, '4:5': true })
})

/**
 * Returning to a backgrounded tab must not show a frozen progress bar. A
 * throttled tab can have its stream die without ever firing onerror, so the
 * reconnect never triggers and only a refocus catch-up closes the gap.
 */
test('needsCatchUp: a job still running wants a refetch', () => {
  expect(needsCatchUp('job-1', 'rendering')).toBe(true)
  expect(needsCatchUp('job-1', 'pending')).toBe(true)
  expect(needsCatchUp('job-1', 'downloading')).toBe(true)
})

test('needsCatchUp: a finished job is left alone', () => {
  expect(needsCatchUp('job-1', 'completed')).toBe(false)
  expect(needsCatchUp('job-1', 'failed')).toBe(false)
  expect(needsCatchUp('job-1', 'cancelled')).toBe(false)
})

test('needsCatchUp: nothing to refetch without a job', () => {
  expect(needsCatchUp('', 'rendering')).toBe(false)
  expect(needsCatchUp('job-1', null)).toBe(false)
})

/**
 * Whether the projects list keeps polling.
 *
 * The cases that matter are the terminal ones: a project that failed must stop
 * the timer, or an open tab hammers /api/projects forever over work that will
 * never change again.
 */
const p = (status: JobStatus) => ({ status })

test('anyProjectRunning: an empty list is not running', () => {
  expect(anyProjectRunning([])).toBe(false)
})

test('anyProjectRunning: a finished list is not running', () => {
  expect(anyProjectRunning([p('completed'), p('completed')])).toBe(false)
})

test('anyProjectRunning: one running among finished ones counts', () => {
  expect(anyProjectRunning([p('completed'), p('rendering'), p('completed')])).toBe(true)
})

test('anyProjectRunning: failed and cancelled are terminal, so polling stops', () => {
  expect(anyProjectRunning([p('failed'), p('cancelled')])).toBe(false)
})
