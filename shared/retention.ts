/**
 * Which source proxies to delete, and in what order.
 *
 * Pure, like quotaVerdict and reconcileVerdict: the rows go in, a plan comes
 * out, and the caller does the deleting. That matters more here than anywhere
 * else in the codebase, because this is the only logic that destroys data
 * nobody asked it to destroy -- so it has to be checkable without a database,
 * a bucket, or a four-hour video.
 *
 * Two rules, in this order:
 *
 *   1. TTL     -- a proxy nobody has opened for PROXY_TTL_DAYS is gone, even if
 *                 there is budget to spare. Idle bytes are still bytes.
 *   2. BUDGET  -- while the total exceeds the ceiling, drop the least recently
 *                 used until it does not.
 *
 * And one rule that overrides both: nothing used inside the grace window is
 * ever evicted. Being over budget for another half hour is recoverable;
 * deleting the file somebody is scrubbing right now is not.
 */

/** The columns retention needs. A slice of the videos row, so it stays pure. */
export interface RetainableVideo {
  id: string
  /** proxy + strip. Null when it was never recorded; counts as zero. */
  proxyBytes: number | null
  /** Null means never opened, which sorts as oldest -- see below. */
  proxyUsedAt: Date | null
}

export interface RetentionLimits {
  budgetBytes: number
  ttlDays: number
  graceMinutes: number
  now: Date
}

export interface RetentionPlan {
  /** Evict in this order. Least recently used first. */
  evict: RetainableVideo[]
  /**
   * Bytes still over the ceiling after carrying out the plan. Non-zero only
   * when the grace window blocked the eviction that would have fixed it.
   */
  overBudgetBytes: number
  /** True when something was spared for being in use. Worth logging. */
  blockedByGrace: boolean
}

/** Bytes a row occupies. Unrecorded means unknown, and unknown frees nothing. */
const bytesOf = (v: RetainableVideo) => v.proxyBytes ?? 0

/**
 * Age rank for sorting, oldest first.
 *
 * A null stamp is treated as infinitely old rather than as "now". It means the
 * proxy predates the column or has never been opened, and reading it the other
 * way would make exactly the least valuable rows immortal.
 */
const usedAtMs = (v: RetainableVideo) =>
  v.proxyUsedAt ? v.proxyUsedAt.getTime() : Number.NEGATIVE_INFINITY

export function evictionPlan(
  videos: RetainableVideo[],
  limits: RetentionLimits,
): RetentionPlan {
  const nowMs = limits.now.getTime()
  const graceCutoff = nowMs - limits.graceMinutes * 60_000
  const ttlCutoff = nowMs - limits.ttlDays * 86_400_000

  /** In use right now. Off limits to both rules. */
  const inGrace = (v: RetainableVideo) => usedAtMs(v) > graceCutoff

  // Least recently used first: the order both rules evict in.
  const oldestFirst = [...videos].sort((a, b) => usedAtMs(a) - usedAtMs(b))

  const evict: RetainableVideo[] = []
  let blockedByGrace = false

  // --- 1. TTL ---------------------------------------------------------------
  for (const v of oldestFirst) {
    if (usedAtMs(v) >= ttlCutoff) continue
    if (inGrace(v)) {
      // Only reachable with a TTL shorter than the grace window, but the rule
      // holds whatever the configuration says.
      blockedByGrace = true
      continue
    }
    evict.push(v)
  }

  // --- 2. Budget ------------------------------------------------------------
  const planned = new Set(evict.map((v) => v.id))
  let total = videos.reduce((sum, v) => sum + bytesOf(v), 0)
  for (const v of evict) total -= bytesOf(v)

  for (const v of oldestFirst) {
    if (total <= limits.budgetBytes) break
    if (planned.has(v.id)) continue
    if (inGrace(v)) {
      blockedByGrace = true
      continue
    }
    evict.push(v)
    planned.add(v.id)
    // A row with no recorded size frees nothing. The loop still terminates:
    // every row is considered at most once.
    total -= bytesOf(v)
  }

  return {
    evict,
    overBudgetBytes: Math.max(0, total - limits.budgetBytes),
    blockedByGrace,
  }
}
