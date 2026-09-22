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
import { eq, isNotNull } from 'drizzle-orm'
import { db, videos, storage } from './db.ts'
import { env } from './env.ts'
import { evictionPlan } from '../../shared/retention.ts'
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
