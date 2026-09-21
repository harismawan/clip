/**
 * The only way to reach a job or a clip.
 *
 * Ten handlers used to load rows by id alone, which was correct while a single
 * shared token meant a single pool of projects. With accounts, each of those is
 * a cross-tenant read unless it filters on the owner -- and a filter repeated at
 * ten call sites is a filter the eleventh handler forgets. Routing every lookup
 * through here makes the owner check impossible to omit rather than merely
 * documented.
 */
import { and, desc, eq, gte, inArray, isNull, count } from 'drizzle-orm'
import { db, jobs, clips } from './db/index.ts'
import { isTerminal } from '../../shared/types.ts'
import { jobStatus } from '../../shared/schema.ts'
import type { Job, Clip } from '../../shared/schema.ts'

/** Statuses that mean "this job is still consuming the box". */
const ACTIVE_STATUSES = jobStatus.enumValues.filter((s) => !isTerminal(s))

/**
 * A job, but only if this user owns it. Callers return 404 on null -- never 403,
 * which would confirm that the id belongs to somebody.
 */
export async function ownedJob(userId: string, jobId: string): Promise<Job | null> {
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.userId, userId), isNull(jobs.deletedAt)))
    .limit(1)
  return job ?? null
}

/**
 * Only the clips from `clipIds` that belong to this user, via their job. Used by
 * the bulk-download endpoint, which takes ids in a request body and is therefore
 * the easiest place to leak a stranger's render.
 */
export async function ownedClips(userId: string, clipIds: string[]): Promise<Clip[]> {
  if (clipIds.length === 0) return []
  const rows = await db
    .select({ clip: clips })
    .from(clips)
    .innerJoin(jobs, eq(clips.jobId, jobs.id))
    .where(and(inArray(clips.id, clipIds), eq(jobs.userId, userId)))
  return rows.map((r) => r.clip)
}

/** One clip, only if this user owns it. */
export async function ownedClip(userId: string, clipId: string): Promise<Clip | null> {
  const [clip] = await ownedClips(userId, [clipId])
  return clip ?? null
}

/**
 * The user's job that is still running, if any.
 *
 * Exists so the app can ask "am I processing something?" without knowing an id.
 * The client cannot answer that itself: `jobId` lives in localStorage, so a job
 * started on another device is invisible and clearing site data loses it.
 *
 * Returns one job, not a list, because the quota refuses a second concurrent job
 * (see quota.ts). `orderBy` is belt and braces for rows predating that rule.
 */
export async function activeJob(userId: string): Promise<Job | null> {
  const [job] = await db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.userId, userId),
        inArray(jobs.status, ACTIVE_STATUSES),
        isNull(jobs.deletedAt),
      ),
    )
    .orderBy(desc(jobs.createdAt))
    .limit(1)
  return job ?? null
}

export async function countActiveJobs(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(jobs)
    .where(and(eq(jobs.userId, userId), inArray(jobs.status, ACTIVE_STATUSES)))
  return Number(row?.n ?? 0)
}

/**
 * How much of the daily allowance this user has spent, and when the oldest job
 * in the window ages out of it.
 *
 * `oldestAt` exists so the UI can say when a slot actually frees up: the
 * allowance is a ROLLING 24 hours, not a calendar month, so "resets on the 1st"
 * would be a lie.
 *
 * Every job counts, cancelled ones included. By the time you cancel, the
 * download has usually already spent the bandwidth and the disk, so returning
 * the slot would make the cap trivial to sidestep by starting and cancelling.
 */
export async function quotaUsage(
  userId: string,
  since: Date,
): Promise<{ used: number; oldestAt: Date | null }> {
  const rows = await db
    .select({ createdAt: jobs.createdAt })
    .from(jobs)
    .where(and(eq(jobs.userId, userId), gte(jobs.createdAt, since)))
    .orderBy(jobs.createdAt)

  return { used: rows.length, oldestAt: rows[0]?.createdAt ?? null }
}

export async function countJobsSince(userId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(jobs)
    .where(and(eq(jobs.userId, userId), gte(jobs.createdAt, since)))
  return Number(row?.n ?? 0)
}
