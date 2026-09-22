/**
 * Which cached originals to delete, and in what order.
 *
 * The sibling of retention.ts, and the same shape for the same reason: the
 * deciding is pure so it can be checked without a disk, and the caller does the
 * deleting. What differs is what is at stake. A proxy is a derived artefact; if
 * this planner is wrong it deletes a multi-gigabyte download that another
 * worker is reading at that moment.
 *
 * Three rules, in this order:
 *
 *   1. IN USE   -- a source with a ref count above zero is untouchable. Not by
 *                  TTL, not by budget, not at any size. Everything below is
 *                  subject to this.
 *   2. TTL      -- the cache exists to bridge one editing session (open the
 *                  editor, save a trim minutes later), so its lifetime is
 *                  measured in minutes, not the days a proxy gets. Holding
 *                  several GB for a session that ended is pure waste.
 *   3. BUDGET   -- while the total exceeds the ceiling, drop the least recently
 *                  used until it does not.
 */

/**
 * The columns the planner needs. A slice of a video_source_cache row, so it
 * stays pure.
 *
 * `id` carries the video id. That is unique here because every caller feeds in
 * ONE host's rows -- the table is keyed (video_id, host_id) and a sweep can
 * only ever delete files on the disk it is running on.
 */
export interface CachedSource {
  id: string
  /** Bytes on disk, from stat() after the download landed. */
  bytes: number
  /** Last read or write. The eviction order. */
  usedAt: Date
  /** Operations holding the file open. Anything but zero means hands off. */
  refs: number
}

export interface SourceCacheLimits {
  budgetBytes: number
  /**
   * Minutes, not days. See the TTL rule above: this cache spans an editing
   * session, and the disk it sits on also has to fit the next download.
   */
  ttlMinutes: number
  now: Date
}

export interface SourceCachePlan {
  /** Evict in this order. Least recently used first. */
  evict: CachedSource[]
  /** Bytes locked by in-use sources. Non-zero is normal, not a fault. */
  heldBytes: number
  /**
   * Bytes still over the ceiling after carrying out the plan. Non-zero only
   * when in-use sources alone exceed the budget -- worth logging, because it
   * means the next download may hit the disk guard.
   */
  overBudgetBytes: number
}

const bytesOf = (s: CachedSource) => s.bytes

/**
 * Is anything holding this file open?
 *
 * `!== 0` rather than `> 0` on purpose. A negative count can only come from a
 * decrement that ran without its increment, and the safe reading of "I don't
 * know who holds this" is "somebody does". A leaked count costs disk until that
 * host reboots and zeroes its own rows; a wrong delete costs somebody's render.
 */
const inUse = (s: CachedSource) => s.refs !== 0

/** Age rank for sorting, oldest first. */
const usedAtMs = (s: CachedSource) => s.usedAt.getTime()

export function sourceEvictionPlan(
  sources: CachedSource[],
  limits: SourceCacheLimits,
): SourceCachePlan {
  const nowMs = limits.now.getTime()
  const ttlCutoff = nowMs - limits.ttlMinutes * 60_000

  const evictable = sources.filter((s) => !inUse(s))
  const heldBytes = sources.filter(inUse).reduce((sum, s) => sum + bytesOf(s), 0)

  // Least recently used first: the order both remaining rules evict in.
  const oldestFirst = [...evictable].sort((a, b) => usedAtMs(a) - usedAtMs(b))

  const evict: CachedSource[] = []
  const planned = new Set<string>()

  // --- 2. TTL ---------------------------------------------------------------
  for (const s of oldestFirst) {
    if (usedAtMs(s) >= ttlCutoff) continue
    evict.push(s)
    planned.add(s.id)
  }

  // --- 3. BUDGET ------------------------------------------------------------
  let total = sources.reduce((sum, s) => sum + bytesOf(s), 0)
  for (const s of evict) total -= bytesOf(s)

  for (const s of oldestFirst) {
    if (total <= limits.budgetBytes) break
    // Already taken by the TTL pass. Listing it twice would have the executor
    // delete a path it has just forgotten.
    if (planned.has(s.id)) continue
    evict.push(s)
    planned.add(s.id)
    // A row with no recorded size frees nothing. The loop still terminates:
    // every row is considered at most once.
    total -= bytesOf(s)
  }

  return {
    evict,
    heldBytes,
    overBudgetBytes: Math.max(0, total - limits.budgetBytes),
  }
}
