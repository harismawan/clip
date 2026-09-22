/**
 * Which cached originals get deleted, and in what order.
 *
 * Pure, and tested at least as hard as the proxy planner, because this one
 * decides the fate of a file another process may be reading RIGHT NOW. A proxy
 * evicted wrongly costs a re-encode. A source evicted wrongly kills a render
 * mid-write, on a file the render did not create and cannot get back -- the
 * exact failure the old scratch-path ownership check existed to prevent.
 *
 * So the ref count is the rule everything else bends around, and it gets the
 * most tests.
 */
import { test, expect, describe } from 'bun:test'
import { sourceEvictionPlan, type CachedSource } from './sourceCache.ts'

const GB = 1024 ** 3
const NOW = new Date('2026-09-22T12:00:00Z')

const agoMin = (m: number) => new Date(NOW.getTime() - m * 60_000)

function source(over: Partial<CachedSource> = {}): CachedSource {
  return {
    id: 'v1',
    bytes: 2 * GB,
    // Recent enough to outlive the TTL these tests use, unless overridden.
    usedAt: agoMin(5),
    refs: 0,
    ...over,
  }
}

const LIMITS = { budgetBytes: 8 * GB, ttlMinutes: 120, now: NOW }

const ids = (rows: CachedSource[]) => rows.map((r) => r.id)

describe('nothing to do', () => {
  test('under budget and nothing expired evicts nothing', () => {
    const rows = [source({ id: 'a' }), source({ id: 'b' })]
    expect(sourceEvictionPlan(rows, LIMITS).evict).toEqual([])
  })

  test('an empty cache is not an error', () => {
    expect(sourceEvictionPlan([], LIMITS).evict).toEqual([])
  })
})

describe('in use', () => {
  test('a held source is never evicted, however stale', () => {
    const rows = [source({ id: 'held', usedAt: agoMin(10_000), refs: 1 })]
    expect(sourceEvictionPlan(rows, LIMITS).evict).toEqual([])
  })

  test('a held source is never evicted, however far over budget', () => {
    const rows = [source({ id: 'held', bytes: 50 * GB, refs: 1 })]
    const plan = sourceEvictionPlan(rows, LIMITS)
    expect(plan.evict).toEqual([])
    // And the caller is told it is still over, so it can log rather than
    // silently believe the sweep worked.
    expect(plan.overBudgetBytes).toBeGreaterThan(0)
  })

  test('holding one does not protect the others', () => {
    const rows = [
      source({ id: 'held', refs: 2, usedAt: agoMin(10_000) }),
      source({ id: 'idle', refs: 0, usedAt: agoMin(10_000) }),
    ]
    expect(ids(sourceEvictionPlan(rows, LIMITS).evict)).toEqual(['idle'])
  })

  test('a negative count is treated as held, not as free to delete', () => {
    // Defensive: a botched decrement must fail toward keeping the file.
    const rows = [source({ id: 'weird', refs: -1, usedAt: agoMin(10_000) })]
    expect(sourceEvictionPlan(rows, LIMITS).evict).toEqual([])
  })
})

describe('ttl', () => {
  test('evicts a source untouched for longer than the ttl', () => {
    const rows = [source({ id: 'stale', usedAt: agoMin(121) })]
    expect(ids(sourceEvictionPlan(rows, LIMITS).evict)).toEqual(['stale'])
  })

  test('keeps one touched inside the ttl', () => {
    const rows = [source({ id: 'fresh', usedAt: agoMin(119) })]
    expect(sourceEvictionPlan(rows, LIMITS).evict).toEqual([])
  })

  test('evicts expired oldest-first', () => {
    const rows = [
      source({ id: 'newer', usedAt: agoMin(121) }),
      source({ id: 'older', usedAt: agoMin(400) }),
    ]
    expect(ids(sourceEvictionPlan(rows, LIMITS).evict)).toEqual(['older', 'newer'])
  })
})

describe('budget', () => {
  test('drops least recently used first until under the ceiling', () => {
    const rows = [
      source({ id: 'newest', bytes: 4 * GB, usedAt: agoMin(1) }),
      source({ id: 'oldest', bytes: 4 * GB, usedAt: agoMin(60) }),
      source({ id: 'middle', bytes: 4 * GB, usedAt: agoMin(30) }),
    ]
    // 12GB against an 8GB ceiling: exactly one must go, and it is the oldest.
    expect(ids(sourceEvictionPlan(rows, LIMITS).evict)).toEqual(['oldest'])
  })

  test('stops as soon as it is under, rather than clearing the cache', () => {
    const rows = [
      source({ id: 'a', bytes: 3 * GB, usedAt: agoMin(60) }),
      source({ id: 'b', bytes: 3 * GB, usedAt: agoMin(50) }),
      source({ id: 'c', bytes: 3 * GB, usedAt: agoMin(40) }),
      source({ id: 'd', bytes: 3 * GB, usedAt: agoMin(30) }),
    ]
    // 12GB, ceiling 8GB: dropping the oldest two gets to 6GB and that is enough.
    expect(ids(sourceEvictionPlan(rows, LIMITS).evict)).toEqual(['a', 'b'])
  })

  test('a zero-byte row frees nothing but still terminates', () => {
    const rows = [
      source({ id: 'empty', bytes: 0, usedAt: agoMin(60) }),
      source({ id: 'big', bytes: 20 * GB, usedAt: agoMin(30) }),
    ]
    const plan = sourceEvictionPlan(rows, LIMITS)
    // Both are considered; the loop cannot spin on the row that frees nothing.
    expect(ids(plan.evict)).toEqual(['empty', 'big'])
  })

  test('a budget of zero clears everything that is not held', () => {
    const rows = [
      source({ id: 'a', refs: 0 }),
      source({ id: 'held', refs: 1 }),
      source({ id: 'b', refs: 0 }),
    ]
    const plan = sourceEvictionPlan(rows, { ...LIMITS, budgetBytes: 0 })
    expect(ids(plan.evict).sort()).toEqual(['a', 'b'])
  })
})

describe('reporting', () => {
  test('counts the bytes still held by in-use rows', () => {
    const rows = [
      source({ id: 'held', bytes: 3 * GB, refs: 1 }),
      source({ id: 'idle', bytes: 3 * GB, refs: 0 }),
    ]
    expect(sourceEvictionPlan(rows, LIMITS).heldBytes).toBe(3 * GB)
  })

  test('reports nothing over budget once the plan fits', () => {
    const rows = [
      source({ id: 'a', bytes: 6 * GB, usedAt: agoMin(60) }),
      source({ id: 'b', bytes: 6 * GB, usedAt: agoMin(30) }),
    ]
    expect(sourceEvictionPlan(rows, LIMITS).overBudgetBytes).toBe(0)
  })

  test('a row is never listed for eviction twice', () => {
    // Expired AND over budget: the TTL pass takes it, the budget pass must not
    // add it again, or the executor deletes a path it already forgot.
    const rows = [
      source({ id: 'stale', bytes: 20 * GB, usedAt: agoMin(10_000) }),
    ]
    expect(ids(sourceEvictionPlan(rows, LIMITS).evict)).toEqual(['stale'])
  })
})
