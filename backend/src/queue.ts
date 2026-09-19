import { makeBoss, PROCESS_QUEUE, RECUT_QUEUE, sendOptions } from '../../shared/queue.ts'
import type { ProcessJobPayload, RecutJobPayload } from '../../shared/queue.ts'
import { env } from './env.ts'

export const boss = makeBoss(env.DATABASE_URL)

let started = false

/**
 * pg-boss creates its schema on first start, so both backend and worker call
 * this; whichever wins the race creates it and the other no-ops.
 */
export async function startQueue() {
  if (started) return
  await boss.start()
  await boss.createQueue(PROCESS_QUEUE)
  await boss.createQueue(RECUT_QUEUE)
  started = true
}

export async function enqueueProcess(payload: ProcessJobPayload) {
  return boss.send(PROCESS_QUEUE, payload, {
    ...sendOptions,
    // One in-flight queue entry per job id; a double-click cannot double-spend
    // 40 minutes of CPU.
    singletonKey: payload.jobId,
  })
}

export async function enqueueRecut(payload: RecutJobPayload) {
  return boss.send(RECUT_QUEUE, payload, {
    ...sendOptions,
    singletonKey: payload.clipId,
  })
}

export { PROCESS_QUEUE, RECUT_QUEUE }
