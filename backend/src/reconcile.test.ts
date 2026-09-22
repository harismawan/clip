/**
 * The rules that decide to rewrite somebody's job status.
 *
 * Worth testing precisely, in both directions: too timid and a project stays
 * permanently unsaveable, too eager and a job that is genuinely mid-render gets
 * declared finished while the worker is still writing to it.
 */
import { describe, expect, test } from 'bun:test'
import { reconcileVerdict, ORPHAN_AFTER_MS } from './reconcile.ts'
import type { ReconcilableJob } from './reconcile.ts'
import type { JobStatus } from '../../shared/types.ts'

const NOW = new Date('2026-09-22T12:00:00Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms)

const job = (over: Partial<ReconcilableJob> = {}): ReconcilableJob => ({
  status: 'rendering',
  completedAt: null,
  startedAt: ago(60_000),
  ...over,
})

describe('reconcileVerdict', () => {
  test('restores a job that finished but was left mid-flight', () => {
    // What "Regenerate this clip" did: ensureDownloaded announced 'downloading'
    // on a job that had already completed, and nothing wrote it back.
    expect(reconcileVerdict(job({ status: 'downloading', completedAt: ago(86_400_000) }), NOW)).toBe(
      'completed',
    )
  })

  test.each(['downloading', 'transcribing', 'analyzing', 'rendering'] as JobStatus[])(
    'restores it from %s, whichever stage the pollution named',
    (status) => {
      expect(reconcileVerdict(job({ status, completedAt: ago(1000) }), NOW)).toBe('completed')
    },
  )

  test('fails an orphan the queue can no longer be holding', () => {
    // A worker killed mid-job leaves this behind; past the queue's expiry no
    // process can ever claim it, so failing it is what allows a regenerate.
    const orphan = job({ status: 'rendering', startedAt: ago(ORPHAN_AFTER_MS + 60_000) })
    expect(reconcileVerdict(orphan, NOW)).toBe('failed')
  })

  test('leaves a job that is still plausibly running', () => {
    // Transcription on a slow box legitimately takes a long time. Inside the
    // queue's expiry there is no evidence anything is wrong.
    expect(reconcileVerdict(job({ startedAt: ago(ORPHAN_AFTER_MS - 60_000) }), NOW)).toBeNull()
  })

  test('leaves a queued job that has not started', () => {
    // No startedAt means it is waiting for a worker, not abandoned by one.
    expect(reconcileVerdict(job({ status: 'pending', startedAt: null }), NOW)).toBeNull()
  })

  test.each(['completed', 'failed', 'cancelled'] as JobStatus[])(
    'never touches an already-terminal job (%s)',
    (status) => {
      expect(reconcileVerdict(job({ status, completedAt: ago(1000) }), NOW)).toBeNull()
      expect(reconcileVerdict(job({ status, completedAt: null }), NOW)).toBeNull()
    },
  )

  test('prefers completed over failed when a row somehow qualifies for both', () => {
    // completedAt is the stronger evidence: the work demonstrably finished, so
    // age is irrelevant.
    const both = job({ status: 'rendering', completedAt: ago(1000), startedAt: ago(ORPHAN_AFTER_MS * 2) })
    expect(reconcileVerdict(both, NOW)).toBe('completed')
  })
})
