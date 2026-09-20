/**
 * pg-boss wiring, shared so the queue name and payload shape have one definition.
 *
 * Chosen over Redis/BullMQ and over a real broker: the workload is long jobs at
 * low throughput (minutes each, tens per day), where a broker's throughput
 * advantage is worthless and its operational surface is pure cost. Living in the
 * same Postgres as the job rows also makes "job claimed" and "job row updated"
 * transactional for free.
 */
import PgBoss from 'pg-boss'

export const PROCESS_QUEUE = 'process-video'
export const RECUT_QUEUE = 'recut-clip'

export interface ProcessJobPayload {
  jobId: string
}

export interface RecutJobPayload {
  jobId: string
  clipId: string
}

export function makeBoss(connectionString: string) {
  return new PgBoss({
    connectionString,
    // Finished jobs stay queryable for a week before moving to pgboss.archive --
    // long enough to debug a failure from the weekend.
    archiveCompletedAfterSeconds: 60 * 60 * 24 * 7,
    // A video job can legitimately run for an hour on 4 cores. The default
    // expiry would reap a healthy job mid-transcription.
    // (Per-queue overrides are set at send time.)
    retryLimit: 0,
  })
}

/** Queue options applied at send time. Video work is expensive: never auto-retry. */
export const sendOptions: PgBoss.SendOptions = {
  // A failed render is nearly always deterministic (bad URL, disk full, model
  // error). Retrying burns another 40 minutes of CPU to fail identically.
  retryLimit: 0,
  expireInHours: 6,
  // Collapse duplicate enqueues of the same job id.
  singletonKey: undefined,
}
