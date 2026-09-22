/**
 * Repair jobs whose status outlived the work it described, at API startup.
 *
 * The API can only decide the exact case: a row carrying a `completed_at` while
 * claiming to be mid-flight finished and was polluted afterwards. It cannot
 * tell whether a job with no `completed_at` is abandoned or is being worked on
 * right now, so it leaves those to the worker -- see shared/reconcile.ts.
 *
 * Runs before the first request, because every write path refuses a job that is
 * not 'completed': a polluted row is a project nobody can save, edit or re-cut.
 */
import { and, eq, isNotNull, notInArray } from 'drizzle-orm'
import { db, jobs } from './db/index.ts'
import { reconcileVerdict } from '../../shared/reconcile.ts'
import type { JobStatus } from '../../shared/types.ts'

const TERMINAL: JobStatus[] = ['completed', 'failed', 'cancelled']

export async function reconcileJobs(): Promise<{ completed: number }> {
  const polluted = await db
    .select()
    .from(jobs)
    .where(and(notInArray(jobs.status, TERMINAL), isNotNull(jobs.completedAt)))

  let completed = 0
  for (const job of polluted) {
    // The claim is false: the API cannot see the worker. Anything this returns
    // 'completed' for is decided by completed_at alone.
    if (reconcileVerdict(job, { nothingIsRunning: false }) !== 'completed') continue
    await db
      .update(jobs)
      .set({ status: 'completed', stage: 'Done', progress: 100, error: null })
      .where(eq(jobs.id, job.id))
    completed++
  }

  return { completed }
}
