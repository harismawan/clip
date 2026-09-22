/**
 * Which source proxies get deleted, and in what order.
 *
 * Pure, and tested harder than anything else in this feature, because it is the
 * only part that destroys data. Everything else it touches can be rebuilt by
 * re-downloading; a wrong answer here deletes a 400MB file out from under
 * somebody who is mid-edit, and the first they know of it is a dead player.
 */
import { test, expect, describe } from 'bun:test'
import { evictionPlan, type RetainableVideo } from './retention.ts'

const MB = 1024 * 1024
const NOW = new Date('2026-09-22T12:00:00Z')

/** Minutes before NOW, as a Date. */
const agoMin = (m: number) => new Date(NOW.getTime() - m * 60_000)
/** Days before NOW, as a Date. */
const agoDays = (d: number) => new Date(NOW.getTime() - d * 86_400_000)

function video(over: Partial<RetainableVideo> = {}): RetainableVideo {
  return {
    id: 'v1',
    proxyBytes: 100 * MB,
    // Old enough to be outside any grace window these tests use.
    proxyUsedAt: agoDays(1),
    ...over,
  }
}

const LIMITS = {
  budgetBytes: 500 * MB,
  ttlDays: 30,
  graceMinutes: 30,
  now: NOW,
}

describe('nothing to do', () => {
  test('under budget and nothing expired evicts nothing', () => {
    const rows = [video({ id: 'a' }), video({ id: 'b' })]
    expect(evictionPlan(rows, LIMITS).evict).toEqual([])
  })

  test('no proxies at all is not an error', () => {
    expect(evictionPlan([], LIMITS).evict).toEqual([])
  })

  test('exactly at the budget is not over it', () => {
    const rows = [video({ id: 'a', proxyBytes: 500 * MB })]
    expect(evictionPlan(rows, LIMITS).evict).toEqual([])
  })
})

describe('the byte budget', () => {
  test('evicts least recently used first', () => {
    const rows = [
      video({ id: 'fresh', proxyUsedAt: agoDays(1) }),
      video({ id: 'stale', proxyUsedAt: agoDays(5) }),
      video({ id: 'middle', proxyUsedAt: agoDays(3) }),
    ]
    // 300MB against a 500MB budget is fine; drop the budget to force one out.
    const plan = evictionPlan(rows, { ...LIMITS, budgetBytes: 250 * MB })
    expect(plan.evict.map((v) => v.id)).toEqual(['stale'])
  })

  test('keeps evicting until it is under budget, oldest-used outward', () => {
    const rows = [
      video({ id: 'a', proxyUsedAt: agoDays(1) }),
      video({ id: 'b', proxyUsedAt: agoDays(9) }),
      video({ id: 'c', proxyUsedAt: agoDays(5) }),
    ]
    // 300MB total, 100MB budget -> two must go, the two least recently used.
    const plan = evictionPlan(rows, { ...LIMITS, budgetBytes: 100 * MB })
    expect(plan.evict.map((v) => v.id)).toEqual(['b', 'c'])
  })

  test('stops as soon as it is under, rather than clearing the lot', () => {
    const rows = [
      video({ id: 'a', proxyUsedAt: agoDays(1) }),
      video({ id: 'b', proxyUsedAt: agoDays(9) }),
      video({ id: 'c', proxyUsedAt: agoDays(5) }),
    ]
    const plan = evictionPlan(rows, { ...LIMITS, budgetBytes: 200 * MB })
    expect(plan.evict.map((v) => v.id)).toEqual(['b'])
  })

  test('a null size counts as zero and cannot wedge the loop', () => {
    // A row whose bytes were never recorded frees nothing when evicted. Without
    // care that is an infinite loop: still over budget, nothing reclaimed.
    const rows = [
      video({ id: 'unsized', proxyBytes: null, proxyUsedAt: agoDays(9) }),
      video({ id: 'real', proxyBytes: 400 * MB, proxyUsedAt: agoDays(1) }),
    ]
    const plan = evictionPlan(rows, { ...LIMITS, budgetBytes: 100 * MB })
    // Both go: the unsized one first by age, and the real one because the
    // total is still over afterwards.
    expect(plan.evict.map((v) => v.id)).toEqual(['unsized', 'real'])
  })
})

describe('the grace window', () => {
  test('never evicts something used inside the window', () => {
    const rows = [
      video({ id: 'active', proxyUsedAt: agoMin(5) }),
      video({ id: 'idle', proxyUsedAt: agoDays(2) }),
    ]
    const plan = evictionPlan(rows, { ...LIMITS, budgetBytes: 100 * MB })
    expect(plan.evict.map((v) => v.id)).toEqual(['idle'])
  })

  test('STOPS rather than evicting when every candidate is in grace', () => {
    // The safety property this whole function exists for. Being over budget for
    // another half hour is recoverable. Deleting the file someone is scrubbing
    // is not.
    const rows = [
      video({ id: 'a', proxyUsedAt: agoMin(2) }),
      video({ id: 'b', proxyUsedAt: agoMin(10) }),
    ]
    const plan = evictionPlan(rows, { ...LIMITS, budgetBytes: 50 * MB })
    expect(plan.evict).toEqual([])
    expect(plan.overBudgetBytes).toBeGreaterThan(0)
    expect(plan.blockedByGrace).toBe(true)
  })

  test('reports it is no longer over budget once it has planned enough', () => {
    const rows = [
      video({ id: 'a', proxyUsedAt: agoDays(1) }),
      video({ id: 'b', proxyUsedAt: agoDays(9) }),
    ]
    const plan = evictionPlan(rows, { ...LIMITS, budgetBytes: 100 * MB })
    expect(plan.overBudgetBytes).toBe(0)
    expect(plan.blockedByGrace).toBe(false)
  })
})

describe('the TTL sweep', () => {
  test('expired proxies go even when there is budget to spare', () => {
    const rows = [
      video({ id: 'ancient', proxyUsedAt: agoDays(40) }),
      video({ id: 'recent', proxyUsedAt: agoDays(2) }),
    ]
    // 200MB against a 500MB budget: the budget would evict nothing.
    const plan = evictionPlan(rows, LIMITS)
    expect(plan.evict.map((v) => v.id)).toEqual(['ancient'])
  })

  test('the TTL respects the grace window too', () => {
    // Not reachable with sane settings, but the rule must hold whatever the
    // configuration says: nothing in use is ever deleted.
    const rows = [video({ id: 'active', proxyUsedAt: agoMin(1) })]
    const plan = evictionPlan(rows, { ...LIMITS, ttlDays: 0 })
    expect(plan.evict).toEqual([])
  })

  test('a proxy never recorded as used is treated as oldest, not as newest', () => {
    // A null stamp means "built before this column existed, or never opened".
    // Reading it as now() would make it immortal.
    const rows = [
      video({ id: 'never-used', proxyUsedAt: null }),
      video({ id: 'used', proxyUsedAt: agoDays(2) }),
    ]
    // 200MB against a 50MB budget, so both have to go and the ORDER is the
    // assertion: the unstamped row is the first out, not the last.
    const plan = evictionPlan(rows, { ...LIMITS, budgetBytes: 50 * MB })
    expect(plan.evict.map((v) => v.id)).toEqual(['never-used', 'used'])
  })
})
