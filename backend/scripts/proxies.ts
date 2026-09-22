/**
 * Inspect and force retention of the full-length source proxies.
 *
 *   bun run proxies            what is stored, how big, how long since used
 *   bun run proxies --sweep    run retention now
 *
 * Retention normally runs after every build and once at worker startup, which
 * is deliberately the whole schedule -- the operation that grows storage is the
 * one that shrinks it, so there is no cron to forget. This is the escape hatch
 * for when you want to see the budget applied without waiting for either.
 *
 * Reads the WORKER's limits, because the worker is what enforces them. Running
 * this with different values in the environment would report a budget nothing
 * actually uses.
 */
import { desc, isNotNull } from 'drizzle-orm'
import { videos, videoSourceCache } from '../../shared/schema.ts'
import { evictionPlan } from '../../shared/retention.ts'
import { fmtBytes } from '../../shared/format.ts'

export interface ProxyArgs {
  sweep: boolean
}

export function parseArgs(argv: string[]): ProxyArgs {
  const args: ProxyArgs = { sweep: false }
  for (const arg of argv) {
    if (arg === '--sweep') args.sweep = true
    else throw new Error(`Unknown option ${arg}. Try: bun run proxies [--sweep]`)
  }
  return args
}

/** Whole days since a date, or null when it has never been used. */
export function daysSince(then: Date | null, now: Date): number | null {
  if (!then) return null
  return Math.floor((now.getTime() - then.getTime()) / 86_400_000)
}

async function main() {
  const args = parseArgs(Bun.argv.slice(2))
  // Imported here, not at the top: env.ts exits the process when the
  // environment is unset, which would make parseArgs untestable.
  const { db } = await import('../src/db/index.ts')

  const budgetGb = Number(process.env.PROXY_BUDGET_GB ?? 6)
  const ttlDays = Number(process.env.PROXY_TTL_DAYS ?? 30)
  const graceMinutes = Number(process.env.PROXY_GRACE_MINUTES ?? 30)
  const now = new Date()

  const rows = await db
    .select()
    .from(videos)
    .where(isNotNull(videos.proxyKey))
    .orderBy(desc(videos.proxyUsedAt))

  const total = rows.reduce((sum, v) => sum + (v.proxyBytes ?? 0), 0)
  const budgetBytes = budgetGb * 1024 ** 3

  console.log(
    `${rows.length} source proxy(ies), ${fmtBytes(total)} of ${fmtBytes(budgetBytes)} ` +
      `(${Math.round((total / budgetBytes) * 100)}%)\n`,
  )

  const plan = evictionPlan(
    rows.map((v) => ({ id: v.id, proxyBytes: v.proxyBytes, proxyUsedAt: v.proxyUsedAt })),
    { budgetBytes, ttlDays, graceMinutes, now },
  )
  const doomed = new Set(plan.evict.map((v) => v.id))

  for (const v of rows) {
    const age = daysSince(v.proxyUsedAt, now)
    console.log(`${doomed.has(v.id) ? '! ' : '  '}${v.title.slice(0, 46)}`)
    console.log(
      `    ${fmtBytes(v.proxyBytes ?? 0)} · ${Math.round(v.durationSeconds / 60)} min · ` +
        `last used ${age === null ? 'never' : `${age}d ago`} · ${v.assetStorage}`,
    )
  }

  if (doomed.size) console.log('\n! = would be evicted by the next sweep.')
  if (plan.blockedByGrace) {
    console.log(
      `Over budget by ${fmtBytes(plan.overBudgetBytes)}, but something is in use ` +
        `(within ${graceMinutes} min). Retention leaves those alone.`,
    )
  }

  await reportSources(db, now)

  if (!args.sweep) {
    if (plan.evict.length) console.log('\nRun with --sweep to carry that out.')
    return
  }

  // The worker owns the doing, so the rules cannot drift between the two.
  const { sweepSourceProxies, sweepSources } = await import('../../worker/src/retention.ts')
  const result = await sweepSourceProxies()
  console.log(
    `\nswept proxies: evicted ${result.evicted}, freed ${fmtBytes(result.freedBytes)}` +
      (result.spared ? ' (something was spared for being in use)' : ''),
  )

  /**
   * Only this host's cached sources, because sweepSources deletes by absolute
   * path -- running it here reclaims the machine the CLI is on, which is the
   * worker box in a single-host deployment and nothing useful otherwise.
   */
  const sources = await sweepSources()
  console.log(
    `swept sources: evicted ${sources.evicted}, freed ${fmtBytes(sources.freedBytes)}` +
      (sources.spared ? ' (something was spared for being in use)' : ''),
  )
}

/**
 * Cached originals, across every host.
 *
 * Read-only and deliberately not host-filtered: the point of showing it here is
 * to answer "what is eating the disk", and on a multi-host deployment the
 * answer may be a machine this CLI is not running on.
 */
async function reportSources(db: { select: () => any }, now: Date) {
  const rows = await db.select().from(videoSourceCache).orderBy(desc(videoSourceCache.usedAt))
  if (rows.length === 0) return

  const total = rows.reduce((sum: number, r: { bytes: number }) => sum + r.bytes, 0)
  const budgetBytes = Number(process.env.SOURCE_BUDGET_GB ?? 8) * 1024 ** 3
  const ttlMinutes = Number(process.env.SOURCE_TTL_MINUTES ?? 60)

  console.log(
    `\n${rows.length} cached source download(s), ${fmtBytes(total)} of ` +
      `${fmtBytes(budgetBytes)} per host (ttl ${ttlMinutes} min)\n`,
  )

  for (const r of rows) {
    const mins = Math.floor((now.getTime() - r.usedAt.getTime()) / 60_000)
    console.log(
      `  ${fmtBytes(r.bytes)} · ${r.hostId} · last used ${mins} min ago` +
        (r.refs !== 0 ? ` · IN USE (${r.refs})` : ''),
    )
  }
}

if (import.meta.main) {
  await main().catch((e: Error) => {
    console.error(e.message)
    process.exit(1)
  })
  process.exit(0)
}
