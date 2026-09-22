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
/**
 * Build the editor's proxy, filmstrip and peaks for a finished job's clips.
 *
 * Separate from the re-cut queue because it renders nothing: a clip that only
 * wants a preview must not pay for its video to be encoded again.
 */
export const BACKFILL_QUEUE = 'backfill-assets'
/**
 * Build the FULL-LENGTH editor assets for one source video, so manual mode can
 * scrub outside the 150-second window a clip pins the timeline to.
 *
 * Its own queue rather than a flag on the backfill, because the unit of work is
 * different: a backfill is per job, this is per VIDEO. Videos are deduplicated
 * by URL and shared between users, so keying the singleton on the video id
 * collapses two people editing the same source into one download and one
 * encode. A job-keyed queue would do the work twice.
 */
export const SOURCE_QUEUE = 'build-source-assets'

export interface ProcessJobPayload {
  jobId: string
}

export interface RecutJobPayload {
  jobId: string
  clipId: string
}

/** Per job, never per clip: one source download covers all of its clips. */
export interface BackfillJobPayload {
  jobId: string
}

/**
 * Per video, because the assets are per video.
 *
 * `jobId` rides along only so the download can be attributed in logs -- the
 * work belongs to the source, not to whichever project happened to ask first.
 */
export interface SourceJobPayload {
  videoId: string
  jobId: string
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
