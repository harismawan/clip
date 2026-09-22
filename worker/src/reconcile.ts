/**
 * Clear abandoned jobs, at worker startup.
 *
 * This is the one place the orphan rule can be decided exactly. The worker is
 * the only process that runs jobs -- `deploy.sh` refuses to start beside a
 * second one, because two workers share a queue and race for its entries -- and
 * a worker that is starting up is not running anything yet. So every job still
 * claiming to be mid-flight at this moment has been abandoned, and no timeout
 * is needed to say so.
 *
 * It matters because a killed job is not merely cosmetic: every write path
 * guards on `status === 'completed'`, so an orphan is a project whose clips can
 * no longer be saved, edited or re-cut.
 */
import { eq, notInArray } from 'drizzle-orm'
import { db, jobs } from './db.ts'
import { reconcileVerdict, ORPHANED_MESSAGE } from '../../shared/reconcile.ts'
import type { JobStatus } from '../../shared/types.ts'

const TERMINAL: JobStatus[] = ['completed', 'failed', 'cancelled']

export async function reconcileOnBoot(): Promise<{ completed: number; failed: number }> {
  const stuck = await db.select().from(jobs).where(notInArray(jobs.status, TERMINAL))

  let completed = 0
  let failed = 0

  for (const job of stuck) {
    const verdict = reconcileVerdict(job, { nothingIsRunning: true })

    if (verdict === 'completed') {
      // Finished, then polluted by a re-cut announcing its own download.
      await db
        .update(jobs)
        .set({ status: 'completed', stage: 'Done', progress: 100, error: null })
        .where(eq(jobs.id, job.id))
      completed++
    } else if (verdict === 'failed') {
      await db
        .update(jobs)
        .set({
          status: 'failed',
          stage: 'Failed',
          error: ORPHANED_MESSAGE,
          completedAt: new Date(),
        })
        .where(eq(jobs.id, job.id))
      failed++
    }
  }

  return { completed, failed }
}
