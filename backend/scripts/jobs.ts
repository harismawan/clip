/**
 * Find a job, stop it, delete it -- for any user, from the server.
 *
 *   bun run jobs                       in-flight jobs, then the 15 most recent
 *   bun run jobs cancel <id>           stop it; the project and its clips stay
 *   bun run jobs delete <id> --yes     stop it, delete its clips and files, hide it
 *
 * <id> can be the first few characters, as `bun run jobs` and `bun run workers`
 * print them. A prefix matching two jobs is refused rather than guessed.
 *
 * The same code paths as the Cancel button and the project Delete, via
 * cancelJob and softDeleteJob -- so a deleted job still counts toward its
 * owner's daily quota, exactly as when they delete it themselves.
 *
 * A cancel is only as good as the worker holding the job. One running code
 * older than the cancel guard in worker/src/progress.ts can write the job back
 * to `downloading` moments later, so this re-reads the row after a pause and
 * says so if that happened, instead of reporting success it cannot promise.
 */
import { desc, eq, inArray, sql } from 'drizzle-orm'
import { jobs, videos, users, clips, renders } from '../../shared/schema.ts'
import { isTerminal } from '../../shared/types.ts'
import { fmtBytes } from '../../shared/format.ts'

export type JobArgs =
  | { cmd: 'list' }
  | { cmd: 'cancel'; id: string }
  | { cmd: 'delete'; id: string; yes: boolean }

const USAGE = 'Try: bun run jobs [cancel <id> | delete <id> --yes]'

/** A uuid or the start of one: hex and dashes, at least four characters. */
const ID = /^[0-9a-f][0-9a-f-]{3,35}$/i

export function parseArgs(argv: string[]): JobArgs {
  const [cmd = 'list', ...rest] = argv
  const flags = rest.filter((a) => a.startsWith('-'))
  const words = rest.filter((a) => !a.startsWith('-'))

  if (cmd === 'list') {
    if (rest.length) throw new Error(`Unexpected ${rest[0]}. ${USAGE}`)
    return { cmd }
  }
  if (cmd !== 'cancel' && cmd !== 'delete') throw new Error(`Unknown command ${cmd}. ${USAGE}`)

  const [id, extra] = words
  if (!id) throw new Error(`${cmd} needs a job id. ${USAGE}`)
  if (extra) throw new Error(`One job at a time; got ${id} and ${extra}.`)
  if (!ID.test(id)) throw new Error(`${id} is not a job id (hex, at least 4 characters).`)

  // Unknown flags are errors, not something ignored beside --yes: a typo in the
  // one flag that authorises deleting files should stop, not proceed.
  const allowed = cmd === 'delete' ? ['--yes'] : []
  const bad = flags.find((f) => !allowed.includes(f))
  if (bad) throw new Error(`Unknown option ${bad} for ${cmd}. ${USAGE}`)

  return cmd === 'delete'
    ? { cmd, id: id.toLowerCase(), yes: flags.includes('--yes') }
    : { cmd, id: id.toLowerCase() }
}

/** How long to wait before checking a cancel held. See the header. */
const HOLD_CHECK_MS = 5000

async function main() {
  const args = parseArgs(Bun.argv.slice(2))
  // Imported here, not at the top: env.ts exits the process when the
  // environment is unset, which would make parseArgs untestable.
  const { db } = await import('../src/db/index.ts')
  const { cancelJob, softDeleteJob } = await import('../src/routes/jobs.ts')
  const { startQueue } = await import('../src/queue.ts')

  const age = (d: Date) => {
    const m = Math.round((Date.now() - d.getTime()) / 60_000)
    return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
  }

  const row = (j: { id: string; email: string; title: string; status: string; stage: string | null; progress: number; createdAt: Date; deletedAt: Date | null }) =>
    [
      j.id.slice(0, 8),
      j.status.padEnd(11),
      `${String(j.progress).padStart(3)}%`,
      age(j.createdAt).padStart(4),
      j.email.padEnd(28).slice(0, 28),
      j.title.slice(0, 44) + (j.deletedAt ? '  [deleted]' : ''),
    ].join('  ')

  const select = {
    id: jobs.id,
    email: users.email,
    title: videos.title,
    status: jobs.status,
    stage: jobs.stage,
    progress: jobs.progress,
    createdAt: jobs.createdAt,
    deletedAt: jobs.deletedAt,
  }
  const base = () =>
    db.select(select).from(jobs).innerJoin(users, eq(users.id, jobs.userId)).innerJoin(videos, eq(videos.id, jobs.videoId))

  if (args.cmd === 'list') {
    const running = await base().where(sql`${jobs.status} not in ('completed','failed','cancelled')`).orderBy(jobs.createdAt)
    const recent = await base().orderBy(desc(jobs.createdAt)).limit(15)

    console.log('IN FLIGHT')
    if (running.length === 0) console.log('  none')
    for (const j of running) console.log('  ' + row(j) + (j.stage ? `  -- ${j.stage}` : ''))
    console.log('\nRECENT')
    for (const j of recent) console.log('  ' + row(j))
    return
  }

  // --- resolve the id -------------------------------------------------------
  // Two rows is enough to know a prefix is ambiguous.
  const matches = await base().where(sql`${jobs.id}::text like ${args.id + '%'}`).limit(2)
  if (matches.length === 0) throw new Error(`No job starts with ${args.id}.`)
  if (matches.length > 1) throw new Error(`${args.id} matches more than one job; give more of the id.`)
  const job = matches[0]!

  console.log(row(job))

  const clipRows = await db.select({ id: clips.id }).from(clips).where(eq(clips.jobId, job.id))
  const [{ bytes }] = clipRows.length
    ? await db
        .select({ bytes: sql<number>`coalesce(sum(${renders.sizeBytes}), 0)::bigint` })
        .from(renders)
        .where(inArray(renders.clipId, clipRows.map((c) => c.id)))
    : [{ bytes: 0 }]

  const running = !isTerminal(job.status)

  if (args.cmd === 'cancel' && !running) {
    console.log(`Already ${job.status}; nothing to stop.`)
    return
  }

  if (args.cmd === 'delete' && !args.yes) {
    console.log(
      `\nThis ${running ? 'stops it, then ' : ''}deletes ${clipRows.length} clip(s) ` +
        `(${fmtBytes(Number(bytes))} of files) and removes the project from ${job.email}'s list.` +
        `\nIt cannot be undone. Re-run with --yes to go ahead.`,
    )
    process.exit(1)
  }

  // --- act ------------------------------------------------------------------
  if (running) {
    // cancelJob pulls the job from pg-boss too, which needs a started instance
    // -- without one the delete throws and is swallowed, leaving the entry.
    await startQueue()
    await cancelJob(job.id)
  }
  if (args.cmd === 'delete') await softDeleteJob(job.id)

  if (!running) {
    console.log(`Deleted ${clipRows.length} clip(s), ${fmtBytes(Number(bytes))} freed.`)
    return
  }

  // --- did it hold? ---------------------------------------------------------
  await Bun.sleep(HOLD_CHECK_MS)
  const [after] = await db.select({ status: jobs.status, stage: jobs.stage }).from(jobs).where(eq(jobs.id, job.id))

  if (after?.status !== 'cancelled') {
    throw new Error(
      `A worker put it back to "${after?.status}" (${after?.stage}) within ${HOLD_CHECK_MS / 1000}s.\n` +
        `It is running code without the cancel guard. Stop that worker -- \`bun run workers\` shows where it is -- then run this again.`,
    )
  }

  console.log(
    args.cmd === 'delete'
      ? `Stopped and deleted: ${clipRows.length} clip(s), ${fmtBytes(Number(bytes))} freed. Still cancelled after ${HOLD_CHECK_MS / 1000}s.`
      : `Stopped. Still cancelled after ${HOLD_CHECK_MS / 1000}s. The project and its clips are kept.`,
  )
}

if (import.meta.main) {
  await main().catch((e: Error) => {
    console.error(e.message)
    process.exit(1)
  })
  process.exit(0)
}
