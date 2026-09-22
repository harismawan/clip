/**
 * Repair jobs whose status no longer describes reality.
 *
 * Two ways a row gets there, both of which leave the project permanently
 * unusable because every write path guards on `status === 'completed'`:
 *
 * 1. `recutClip` called `ensureDownloaded`, which announced 'downloading' on a
 *    job that had already finished, and nothing ever wrote the status back. A
 *    single press of "Regenerate this clip" bricked saving for that project.
 *    Fixed at source by the `quiet` option, but rows corrupted before that stay
 *    corrupted.
 *
 * 2. The worker was killed mid-job -- which is what restarting `clip-worker`
 *    does to anything in flight. The row keeps whatever stage it had reached
 *    and no process is coming back for it.
 *
 * Runs once at API startup. Neither case is recoverable by the user: cancelling
 * needs a non-terminal status it no longer trusts, and there is no UI anywhere
 * that sets a job back to completed.
 */
import { and, eq, isNotNull, isNull, lt, notInArray } from 'drizzle-orm'
import { db, jobs } from './db/index.ts'
import { sendOptions } from '../../shared/queue.ts'
import type { JobStatus } from '../../shared/types.ts'

const TERMINAL: JobStatus[] = ['completed', 'failed', 'cancelled']

/**
 * How long a non-terminal job may sit before nothing can possibly run it.
 *
 * Tied to the queue's own expiry rather than guessed: past `expireInHours`
 * pg-boss has dropped the entry, so no worker will ever claim it. A job still
 * inside that window might legitimately be mid-transcription on a slow box.
 */
export const ORPHAN_AFTER_MS = (sendOptions.expireInHours ?? 6) * 3600_000

export interface ReconcilableJob {
  status: JobStatus
  completedAt: Date | null
  startedAt: Date | null
}

/**
 * What a row's status should be, or null to leave it alone.
 *
 * Pure, so the rules can be tested without a database -- and because deciding
 * to rewrite somebody's job status deserves to be readable in one place.
 */
export function reconcileVerdict(job: ReconcilableJob, now: Date): 'completed' | 'failed' | null {
  if (TERMINAL.includes(job.status)) return null

  /**
   * Exact, not a heuristic: `completed_at` is only ever written alongside a
   * terminal status, so a row carrying one while claiming to be mid-flight was
   * polluted after it finished. The work really is done.
   */
  if (job.completedAt) return 'completed'

  // Never finished, and too old for the queue to still hold it. Failing it is
  // what lets the owner regenerate instead of watching it forever.
  const since = job.startedAt ?? null
  if (since && now.getTime() - since.getTime() > ORPHAN_AFTER_MS) return 'failed'

  return null
}

/** Apply the verdicts. Returns how many rows were repaired, for the boot log. */
export async function reconcileJobs(now = new Date()): Promise<{ completed: number; failed: number }> {
  // Only ever touches non-terminal rows, so a finished project can never be
  // rewritten by this no matter what else is true of it.
  const stuck = await db
    .select()
    .from(jobs)
    .where(and(notInArray(jobs.status, TERMINAL), isNotNull(jobs.completedAt)))

  let completed = 0
  for (const job of stuck) {
    if (reconcileVerdict(job, now) !== 'completed') continue
    await db
      .update(jobs)
      .set({ status: 'completed', stage: 'Done', progress: 100, error: null })
      .where(eq(jobs.id, job.id))
    completed++
  }

  const orphanCutoff = new Date(now.getTime() - ORPHAN_AFTER_MS)
  const orphans = await db
    .select()
    .from(jobs)
    .where(
      and(
        notInArray(jobs.status, TERMINAL),
        isNull(jobs.completedAt),
        lt(jobs.startedAt, orphanCutoff),
      ),
    )

  let failed = 0
  for (const job of orphans) {
    if (reconcileVerdict(job, now) !== 'failed') continue
    await db
      .update(jobs)
      .set({
        status: 'failed',
        stage: 'Failed',
        error: 'The worker stopped before this finished. Regenerate it to try again.',
        completedAt: now,
      })
      .where(eq(jobs.id, job.id))
    failed++
  }

  return { completed, failed }
}
