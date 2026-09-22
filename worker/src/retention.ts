/**
 * Carry out the retention plan: delete the objects, then forget the keys.
 *
 * The deciding is in shared/retention.ts and is pure. This half is the part
 * that touches the world, and it is deliberately thin -- a wrong decision here
 * deletes somebody's source mid-edit, so the decision lives where it can be
 * tested without a bucket.
 *
 * Runs after every successful build and once at worker startup. That is the
 * whole schedule: the operation that grows storage is the one that shrinks it,
 * so there is no cron to forget. `bun run proxies --sweep` forces it by hand.
 */
import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { eq, and, isNotNull } from 'drizzle-orm'
import { db, videos, videoSourceCache, storage } from './db.ts'
import { env } from './env.ts'
import { evictionPlan } from '../../shared/retention.ts'
import { sourceEvictionPlan } from '../../shared/sourceCache.ts'
import { fmtBytes } from '../../shared/format.ts'

export interface SweepResult {
  evicted: number
  freedBytes: number
  /** Kept because they were in use, while still over budget. */
  spared: number
}

export async function sweepSourceProxies(): Promise<SweepResult> {
  const rows = await db.select().from(videos).where(isNotNull(videos.proxyKey))

  const plan = evictionPlan(
    rows.map((v) => ({ id: v.id, proxyBytes: v.proxyBytes, proxyUsedAt: v.proxyUsedAt })),
    {
      budgetBytes: env.PROXY_BUDGET_GB * 1024 ** 3,
      ttlDays: env.PROXY_TTL_DAYS,
      graceMinutes: env.PROXY_GRACE_MINUTES,
      now: new Date(),
    },
  )

  if (plan.blockedByGrace) {
    console.warn(
      `[retention] ${fmtBytes(plan.overBudgetBytes)} over budget, but every ` +
        `candidate is in use. Leaving them alone; the next sweep will retry.`,
    )
  }

  let evicted = 0
  let freedBytes = 0

  for (const target of plan.evict) {
    const row = rows.find((v) => v.id === target.id)
    if (!row?.proxyKey || !row.assetStorage) continue

    const objects = [row.proxyKey, row.stripKey]
      .filter(Boolean)
      .map((key) => ({ storage: row.assetStorage as string, key: key as string }))

    const failed = await storage.deleteMany(objects)
    if (failed.length) {
      /**
       * Leave the row alone. Nulling it now would make the object unreachable
       * by every future sweep -- an orphan that quietly holds the budget it was
       * meant to release. The next sweep retries instead.
       */
      console.error(
        `[retention] keeping ${row.id}: its backend(s) ${failed.join(', ')} ` +
          `refused the delete, so forgetting the keys would orphan the objects.`,
      )
      continue
    }

    await db
      .update(videos)
      .set({
        proxyKey: null,
        stripKey: null,
        peaks: null,
        assetStorage: null,
        proxyBytes: null,
        proxyUsedAt: null,
      })
      .where(eq(videos.id, row.id))

    evicted++
    freedBytes += row.proxyBytes ?? 0
  }

  if (evicted) {
    console.log(`[retention] evicted ${evicted} source proxy(ies), freed ${fmtBytes(freedBytes)}`)
  }

  return { evicted, freedBytes, spared: plan.blockedByGrace ? 1 : 0 }
}

/**
 * Evict cached original downloads on THIS host's disk.
 *
 * The sibling of sweepSourceProxies above, and deliberately the same shape:
 * shared/sourceCache.ts decides, this half touches the world. What differs is
 * what is at stake. A proxy evicted wrongly costs a re-encode; a source
 * evicted wrongly kills a render mid-write, on a file it did not create and
 * cannot get back. Hence the ref count the planner bends everything around.
 *
 * Runs at worker startup, after every released lease, and once more before any
 * download -- so the budget makes room for the file about to arrive rather than
 * only tidying up behind it. That last one is why an 8GB cache does not cause
 * the disk-full failures it exists to absorb.
 *
 * HOST-SCOPED, ALWAYS. `path` is absolute on one machine, and deleting by a
 * path another host recorded would either miss or, far worse, hit an unrelated
 * file of the same name.
 */
export async function sweepSources(): Promise<SweepResult> {
  const rows = await db
    .select()
    .from(videoSourceCache)
    .where(eq(videoSourceCache.hostId, env.WORKER_HOST_ID))

  const plan = sourceEvictionPlan(
    rows.map((r) => ({ id: r.videoId, bytes: r.bytes, usedAt: r.usedAt, refs: r.refs })),
    {
      budgetBytes: env.SOURCE_BUDGET_GB * 1024 ** 3,
      ttlMinutes: env.SOURCE_TTL_MINUTES,
      now: new Date(),
    },
  )

  if (plan.overBudgetBytes > 0) {
    console.warn(
      `[sources] ${fmtBytes(plan.overBudgetBytes)} over budget with ` +
        `${fmtBytes(plan.heldBytes)} held by running work. Leaving it; the next ` +
        `sweep will retry once those leases are released.`,
    )
  }

  let evicted = 0
  let freedBytes = 0

  for (const target of plan.evict) {
    const row = rows.find((r) => r.videoId === target.id)
    if (!row) continue

    /**
     * The file, then the row -- never the other way round.
     *
     * Forgetting the path while the file survives leaves an orphan no future
     * sweep can find, silently holding budget forever. The proxy sweep above
     * states the same rule for the same reason. A failed delete keeps the row
     * and retries next time.
     */
    try {
      await rm(dirname(row.path), { recursive: true, force: true })
    } catch (e) {
      console.error(
        `[sources] keeping ${row.videoId}: could not delete ${dirname(row.path)} ` +
          `(${(e as Error).message}), and forgetting it would orphan the file.`,
      )
      continue
    }

    await db
      .delete(videoSourceCache)
      .where(
        and(
          eq(videoSourceCache.videoId, row.videoId),
          eq(videoSourceCache.hostId, env.WORKER_HOST_ID),
        ),
      )

    evicted++
    freedBytes += row.bytes
  }

  if (evicted) {
    console.log(`[sources] evicted ${evicted} cached source(s), freed ${fmtBytes(freedBytes)}`)
  }

  return { evicted, freedBytes, spared: plan.heldBytes > 0 ? 1 : 0 }
}
