/**
 * Per-user fairness on a 4-core box with worker concurrency 1.
 *
 * Signup is open to any Google account, so without this `POST /api/jobs` is a
 * free-compute faucet: ten strangers with an hour-long video each turn into a
 * ten-hour wait for everyone behind them.
 *
 * The decision is pure over two counts so the boundaries are testable without a
 * database; the counting itself lives in the route.
 */
export interface QuotaCounts {
  activeCount: number
  dailyCount: number
  dailyLimit: number
}

export interface QuotaRefusal {
  status: 409 | 429
  message: string
}

export function quotaVerdict({ activeCount, dailyCount, dailyLimit }: QuotaCounts): QuotaRefusal | null {
  // Reported first because it is the one the user can act on: wait, or cancel.
  if (activeCount >= 1) {
    return {
      status: 409,
      message: 'You already have a clip job running. Wait for it to finish, or cancel it.',
    }
  }

  if (dailyCount >= dailyLimit) {
    return {
      status: 429,
      message: `Daily limit reached (${dailyLimit} jobs in 24 hours). Try again tomorrow.`,
    }
  }

  return null
}
