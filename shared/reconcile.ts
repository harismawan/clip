/**
 * Whether a job's status still describes reality.
 *
 * Shared so the API and the worker can never disagree about it. Pure: the row
 * goes in, a verdict comes out, and each side runs its own query -- their `db`
 * handles are different instances over the same schema.
 *
 * Two ways a row goes wrong, both of which leave a project permanently
 * unusable, because every write path guards on `status === 'completed'`:
 *
 * 1. `ensureDownloaded` announced 'downloading' on a job that had already
 *    finished, and nothing wrote the status back. Fixed at source by its
 *    `quiet` option; rows corrupted beforehand stay corrupted.
 * 2. The worker was killed mid-job -- which is what restarting `clip-worker`
 *    does to anything in flight.
 */
import type { JobStatus } from './types.ts'

const TERMINAL: JobStatus[] = ['completed', 'failed', 'cancelled']

export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL.includes(status)
}

export interface ReconcilableJob {
  status: JobStatus
  completedAt: Date | null
}

export interface ReconcileClaim {
  /**
   * Whether the caller KNOWS nothing is processing a job right now.
   *
   * Only the worker can claim this, and only while starting up: it is the sole
   * process that runs jobs (`deploy.sh` refuses to start beside a second one),
   * so anything still claiming to be mid-flight at that moment is abandoned.
   *
   * The API always passes false. It has no way to see what the worker is doing,
   * which is why the first version of this rule needed a six-hour timeout and
   * left a killed job stuck for six hours.
   */
  nothingIsRunning: boolean
}

/** What a row's status should be, or null to leave it alone. */
export function reconcileVerdict(
  job: ReconcilableJob,
  claim: ReconcileClaim,
): 'completed' | 'failed' | null {
  if (isTerminalStatus(job.status)) return null

  /**
   * Exact, not a heuristic: `completed_at` is only ever written alongside a
   * terminal status, so a row carrying one while claiming to be mid-flight was
   * polluted after it finished. The work really is done, whoever is asking.
   */
  if (job.completedAt) return 'completed'

  // Never finished, and the caller can see that nothing is working on it.
  if (claim.nothingIsRunning) return 'failed'

  return null
}

/** Shown on a job failed by the reconciler, so the owner knows to re-run it. */
export const ORPHANED_MESSAGE =
  'The worker stopped before this finished. Regenerate it to try again.'
