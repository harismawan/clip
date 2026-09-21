/**
 * Read and adjust one user's clip allowance, from the box.
 *
 *   bun run quota <email>                   show what the server would decide
 *   bun run quota <email> --limit 20        give this user 20 jobs per 24h
 *   bun run quota <email> --limit default   put them back on QUOTA_JOBS_PER_DAY
 *   bun run quota <email> --release         cancel a job that is stuck running
 *
 * Two different things block a new job (see quota.ts): a job still running, and
 * the rolling 24-hour count. The status output names which one is biting,
 * because raising the limit does nothing for a user whose last job is wedged in
 * 'rendering', and --release does nothing for one who is simply out of slots.
 *
 * Nothing here rewrites jobs.created_at: the window is derived from it and the
 * UI reports "resets at" from the oldest row, so backdating would buy a slot by
 * lying about history. The override column is the honest lever.
 */
import { and, eq, gte, inArray } from 'drizzle-orm'
import { users, jobs, jobStatus } from '../../shared/schema.ts'
import { isTerminal } from '../../shared/types.ts'
import { quotaVerdict } from '../src/quota.ts'

export interface QuotaArgs {
  email: string
  /** A number to set, null to clear the override, undefined to leave it alone. */
  limit: number | null | undefined
  release: boolean
}

export function parseArgs(argv: string[]): QuotaArgs {
  let email: string | undefined
  let limit: number | null | undefined
  let release = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--release') {
      release = true
    } else if (arg === '--limit') {
      const raw = argv[++i]
      if (raw === undefined) throw new Error('--limit needs a number, or "default"')
      if (raw === 'default') {
        limit = null
      } else {
        limit = Number(raw)
        if (!Number.isInteger(limit) || limit < 0) {
          throw new Error(`--limit must be a whole number >= 0, or "default" (got "${raw}")`)
        }
      }
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option ${arg}`)
    } else if (email === undefined) {
      email = arg
    } else {
      throw new Error(`Unexpected argument "${arg}"`)
    }
  }

  if (email === undefined) throw new Error('Usage: bun run quota <email> [--limit N|default] [--release]')
  return { email, limit, release }
}

const ACTIVE = jobStatus.enumValues.filter((s) => !isTerminal(s))
const WINDOW_MS = 86_400_000

async function main() {
  const args = parseArgs(Bun.argv.slice(2))
  // Imported here, not at the top: env.ts exits the process when the
  // environment is unset, which would make parseArgs untestable.
  const { db } = await import('../src/db/index.ts')
  const { env } = await import('../src/env.ts')

  const [user] = await db.select().from(users).where(eq(users.email, args.email)).limit(1)
  if (!user) {
    console.error(`No user with email ${args.email}`)
    process.exit(1)
  }

  if (args.release) {
    // Same write the cancel route makes. The worker checks status between
    // stages, so a job it is still holding stops at the next boundary.
    const freed = await db
      .update(jobs)
      .set({ status: 'cancelled', stage: 'Cancelled (admin)', completedAt: new Date() })
      .where(and(eq(jobs.userId, user.id), inArray(jobs.status, ACTIVE)))
      .returning({ id: jobs.id })
    console.log(`Released ${freed.length} stuck job(s).`)
    // ponytail: the pg-boss row is left alone; the worker's own status check
    // drops it. Delete it here too if abandoned queue rows start piling up.
  }

  if (args.limit !== undefined) {
    await db.update(users).set({ dailyJobLimit: args.limit }).where(eq(users.id, user.id))
    console.log(
      args.limit === null
        ? `Override cleared — back on the default of ${env.QUOTA_JOBS_PER_DAY}/day.`
        : `Daily limit for ${user.email} set to ${args.limit}.`,
    )
  }

  const since = new Date(Date.now() - WINDOW_MS)
  const recent = await db
    .select({ createdAt: jobs.createdAt })
    .from(jobs)
    .where(and(eq(jobs.userId, user.id), gte(jobs.createdAt, since)))
    .orderBy(jobs.createdAt)
  const active = await db
    .select({ id: jobs.id, status: jobs.status })
    .from(jobs)
    .where(and(eq(jobs.userId, user.id), inArray(jobs.status, ACTIVE)))

  const effectiveLimit = (args.limit === undefined ? user.dailyJobLimit : args.limit) ?? env.QUOTA_JOBS_PER_DAY
  const refusal = quotaVerdict({
    activeCount: active.length,
    dailyCount: recent.length,
    dailyLimit: effectiveLimit,
  })

  console.log(`\n${user.email} (${user.id})`)
  console.log(`  limit        ${effectiveLimit}/day${user.dailyJobLimit === null && args.limit === undefined ? ' (global default)' : ' (per-user override)'}`)
  console.log(`  used         ${recent.length} in the last 24h`)
  console.log(`  running now  ${active.length}${active.length ? ` (${active.map((j) => j.status).join(', ')})` : ''}`)
  if (recent[0]) {
    console.log(`  oldest ages out at ${new Date(recent[0].createdAt.getTime() + WINDOW_MS).toISOString()}`)
  }
  console.log(refusal ? `  BLOCKED — ${refusal.message}` : '  CAN START A NEW JOB')
}

if (import.meta.main) {
  await main()
  process.exit(0)
}
