import { test, expect, describe } from 'bun:test'
import { quotaVerdict } from './quota.ts'

describe('quotaVerdict', () => {
  const limit = 3

  test('a first job of the day is allowed', () => {
    expect(quotaVerdict({ activeCount: 0, dailyCount: 0, dailyLimit: limit })).toBeNull()
  })

  test('a second concurrent job is refused with 409 -- worker concurrency is 1', () => {
    const v = quotaVerdict({ activeCount: 1, dailyCount: 1, dailyLimit: limit })
    expect(v?.status).toBe(409)
    expect(v?.message).toMatch(/already have/i)
  })

  test('the daily cap refuses with 429, a different problem from a conflict', () => {
    const v = quotaVerdict({ activeCount: 0, dailyCount: 3, dailyLimit: limit })
    expect(v?.status).toBe(429)
    expect(v?.message).toMatch(/limit/i)
  })

  test('one under the daily cap is still allowed', () => {
    expect(quotaVerdict({ activeCount: 0, dailyCount: 2, dailyLimit: limit })).toBeNull()
  })

  test('over the daily cap stays refused, not wrapped around', () => {
    expect(quotaVerdict({ activeCount: 0, dailyCount: 99, dailyLimit: limit })?.status).toBe(429)
  })

  test('a running job is reported before the daily cap: it is the fixable one', () => {
    const v = quotaVerdict({ activeCount: 1, dailyCount: 3, dailyLimit: limit })
    expect(v?.status).toBe(409)
  })

  test('a limit of zero refuses everyone, rather than being read as unlimited', () => {
    expect(quotaVerdict({ activeCount: 0, dailyCount: 0, dailyLimit: 0 })?.status).toBe(429)
  })
})

describe('quotaVerdict storage', () => {
  const GB = 1024 ** 3
  const ok = { activeCount: 0, dailyCount: 0, dailyLimit: 3 }

  test('room to spare is allowed', () => {
    expect(quotaVerdict({ ...ok, storageBytes: 1 * GB, storageLimitBytes: 5 * GB })).toBeNull()
  })

  test('a full disk refuses with 507, not the daily 429', () => {
    const v = quotaVerdict({ ...ok, storageBytes: 5 * GB, storageLimitBytes: 5 * GB })
    expect(v?.status).toBe(507)
    // The user can act on this one: the message has to say how.
    expect(v?.message).toMatch(/delete/i)
  })

  test('the message names both sides in units a person reads', () => {
    const v = quotaVerdict({ ...ok, storageBytes: 6 * GB, storageLimitBytes: 5 * GB })
    expect(v?.message).toContain('5.0 GB')
  })

  test('one byte under the cap is still allowed', () => {
    expect(
      quotaVerdict({ ...ok, storageBytes: 5 * GB - 1, storageLimitBytes: 5 * GB }),
    ).toBeNull()
  })

  test('a running job is still reported first -- waiting fixes it, deleting does not', () => {
    const v = quotaVerdict({
      activeCount: 1,
      dailyCount: 0,
      dailyLimit: 3,
      storageBytes: 9 * GB,
      storageLimitBytes: 5 * GB,
    })
    expect(v?.status).toBe(409)
  })

  test('storage is reported before the daily cap: freeing space beats waiting a day', () => {
    const v = quotaVerdict({
      activeCount: 0,
      dailyCount: 3,
      dailyLimit: 3,
      storageBytes: 9 * GB,
      storageLimitBytes: 5 * GB,
    })
    expect(v?.status).toBe(507)
  })

  test('omitting the storage counts leaves the old two rules untouched', () => {
    // The worker and the tests that predate storage call it without them.
    expect(quotaVerdict(ok)).toBeNull()
  })
})
