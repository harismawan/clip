import { beforeEach, expect, test, vi } from 'vitest'
import { clampTrim, firstEnabled, restored, saveProject } from '../state/useSnipline'
import type { SnipState } from '../state/useSnipline'
import { ago } from './format'
import { savePersisted } from './persist'
import type { Persisted } from './persist'
import type { Clip, Project } from '../types'

const clip = (id: number): Clip => ({
  id,
  selected: false,
  t: 'a moment',
  s: 100,
  e: 140,
  sc: 70,
  sn: '',
  cap: '',
  line: '',
})

const base = {
  trimIn: 20,
  trimOut: 60,
  playhead: 40,
  jobId: 'job-1',
  source: 'stream',
  clips: [clip(0)],
  projects: [] as Project[],
} as SnipState

test('clampTrim keeps the window inside 0–100 and never inverts it', () => {
  expect(clampTrim(base, 'in', -50).trimIn).toBe(0)
  expect(clampTrim(base, 'out', 500).trimOut).toBe(100)
  // Pushing the in point past the out point stops a minimum span short of it.
  expect(clampTrim(base, 'in', 90).trimIn).toBe(56)
  expect(clampTrim(base, 'out', 5).trimOut).toBe(24)
  // Moving the in point drags the playhead with it; moving the out point doesn't.
  expect(clampTrim(base, 'in', 30).playhead).toBe(30)
  expect(clampTrim(base, 'out', 80).playhead).toBe(40)
})

test('firstEnabled picks the leftmost rendered format', () => {
  expect(firstEnabled({ '9:16': false, '1:1': true, '4:5': true })).toBe('1:1')
  expect(firstEnabled({ '9:16': true, '1:1': true, '4:5': false })).toBe('9:16')
  // Nothing selected shouldn't leave the results tabs with no format at all.
  expect(firstEnabled({ '9:16': false, '1:1': false, '4:5': false })).toBe('9:16')
})

test('saveProject prepends a new job but replaces a regenerated one', () => {
  const older: Project = {
    id: 'job-0',
    title: 'older',
    source: 'stream',
    clips: [],
    createdAt: 1,
  }
  const first = saveProject({ ...base, projects: [older] })
  expect(first.map((p) => p.id)).toEqual(['job-1', 'job-0'])

  // Re-running the same job id must not leave two rows for one video.
  const again = saveProject({ ...base, projects: first, clips: [clip(0), clip(1)] })
  expect(again.map((p) => p.id)).toEqual(['job-1', 'job-0'])
  expect(again[0].clips).toHaveLength(2)
})

const project: Project = {
  id: 'job-1',
  title: 'a stream',
  source: 'stream',
  clips: [clip(0), clip(1)],
  createdAt: 1,
}

const saved = (over: Partial<Persisted>) =>
  savePersisted({
    projects: [project],
    jobId: 'job-1',
    videosUsed: 1,
    count: 12,
    lengthIdx: 1,
    formats: { '9:16': true, '1:1': false, '4:5': false },
    subs: true,
    emailMe: true,
    screen: 'projects',
    ...over,
  })

beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  })
})

test('restored hands the clip screens their clips back, or backs off them', () => {
  saved({ screen: 'results' })
  expect(restored().clips).toHaveLength(2)

  // The editor needs one clip in particular, which isn't persisted.
  saved({ screen: 'editor' })
  expect(restored().screen).toBe('results')

  // A job whose project is gone can't show a grid.
  saved({ screen: 'results', jobId: 'gone' })
  expect(restored().screen).toBe('new')

  // A half-finished job's timer died with the page.
  saved({ screen: 'processing' })
  expect(restored().screen).toBe('new')
})

test('restored survives storage that is junk or unavailable', () => {
  localStorage.setItem('snipline.v1', '{not json')
  expect(restored()).toEqual({})

  localStorage.setItem('snipline.v1', '{"projects":"nope","screen":"projects"}')
  expect(restored().projects).toBeUndefined()

  vi.stubGlobal('localStorage', undefined)
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
