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
