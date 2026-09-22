/**
 * The rules that decide to rewrite somebody's job status.
 *
 * Worth testing in both directions: too timid and a project stays permanently
 * unsaveable, too eager and a job that is genuinely mid-render gets declared
 * finished while the worker is still writing to it.
 */
import { describe, expect, test } from 'bun:test'
import { reconcileVerdict } from './reconcile.ts'
import type { ReconcilableJob } from './reconcile.ts'
import type { JobStatus } from './types.ts'

const RUNNING: JobStatus[] = ['pending', 'downloading', 'transcribing', 'analyzing', 'rendering']
const TERMINAL: JobStatus[] = ['completed', 'failed', 'cancelled']

const job = (over: Partial<ReconcilableJob> = {}): ReconcilableJob => ({
  status: 'rendering',
  completedAt: null,
  ...over,
})

/** The API: it cannot see the worker, so it may never assume idleness. */
const API = { nothingIsRunning: false }
/** The worker at startup: it is the only runner, and it has not started yet. */
const WORKER_BOOT = { nothingIsRunning: true }

describe('reconcileVerdict', () => {
  test.each(RUNNING)('restores a finished job polluted at %s, whoever asks', (status) => {
    // What "Regenerate this clip" did: ensureDownloaded announced its own
    // download on a job that had already completed. completed_at is only ever
    // written on a terminal transition, so it is proof the work finished.
    const polluted = job({ status, completedAt: new Date('2026-09-21T10:00:00Z') })
    expect(reconcileVerdict(polluted, API)).toBe('completed')
    expect(reconcileVerdict(polluted, WORKER_BOOT)).toBe('completed')
  })

  test.each(RUNNING)('leaves %s alone when the caller cannot see what is running', (status) => {
    // The API must never fail a job on a guess: it has no view of the worker,
    // and a slow transcription looks identical to an abandoned one.
    expect(reconcileVerdict(job({ status }), API)).toBeNull()
  })

  test.each(RUNNING)('fails an abandoned %s job when the caller knows nothing runs', (status) => {
    expect(reconcileVerdict(job({ status }), WORKER_BOOT)).toBe('failed')
  })

  test.each(TERMINAL)('never touches an already-terminal job (%s)', (status) => {
    expect(reconcileVerdict(job({ status }), WORKER_BOOT)).toBeNull()
    expect(reconcileVerdict(job({ status, completedAt: new Date() }), WORKER_BOOT)).toBeNull()
    expect(reconcileVerdict(job({ status }), API)).toBeNull()
  })

  test('prefers completed over failed when a row qualifies for both', () => {
    // completed_at is the stronger evidence: the work demonstrably finished, so
    // the fact that nothing is running it now says nothing.
    const both = job({ status: 'rendering', completedAt: new Date() })
    expect(reconcileVerdict(both, WORKER_BOOT)).toBe('completed')
  })
})
