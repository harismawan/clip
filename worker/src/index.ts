/**
 * Worker entrypoint. Consumes the pg-boss queues and runs the pipeline.
 *
 * Concurrency defaults to 1: whisper and x264 each want every core, so
 * overlapping jobs make both slower and risk the OOM killer on a box with
 * ~4GB free.
 */
import { mkdir } from 'node:fs/promises'
import { makeBoss, PROCESS_QUEUE, RECUT_QUEUE } from '../../shared/queue.ts'
import type { ProcessJobPayload, RecutJobPayload } from '../../shared/queue.ts'
import { env } from './env.ts'
import { pool } from './db.ts'
import { processJob, recutClip } from './pipeline.ts'

const boss = makeBoss(env.DATABASE_URL)

boss.on('error', (err) => console.error('[boss]', err))

await mkdir(env.WORK_DIR, { recursive: true })
await boss.start()
await boss.createQueue(PROCESS_QUEUE)
await boss.createQueue(RECUT_QUEUE)

await boss.work<ProcessJobPayload>(
  PROCESS_QUEUE,
  { batchSize: 1, pollingIntervalSeconds: 2 },
  async ([job]) => {
    if (!job) return
    console.log(`[worker] processing job ${job.data.jobId}`)
    // processJob owns its own error handling and writes the failure to the row;
    // throwing here would only mark the queue entry failed, which no UI reads.
    await processJob(job.data.jobId)
    console.log(`[worker] finished job ${job.data.jobId}`)
  },
)

await boss.work<RecutJobPayload>(
  RECUT_QUEUE,
  { batchSize: 1, pollingIntervalSeconds: 2 },
  async ([job]) => {
    if (!job) return
    console.log(`[worker] recutting clip ${job.data.clipId}`)
    await recutClip(job.data.jobId, job.data.clipId)
  },
)

console.log(
  `worker ready (concurrency ${env.WORKER_CONCURRENCY}, whisper "${env.WHISPER_MODEL}", work dir ${env.WORK_DIR})`,
)

let shuttingDown = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\n[worker] ${signal} -- finishing current work, then exiting`)
    // stop() waits for in-flight handlers, so a job mid-transcription is not
    // abandoned halfway with its scratch directory left behind.
    await boss.stop({ graceful: true, timeout: 30_000 }).catch(() => {})
    await pool.end().catch(() => {})
    process.exit(0)
  })
}
