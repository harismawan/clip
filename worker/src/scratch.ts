/**
 * Ownership of a cached download.
 *
 * `videos.scratch_path` is a single global column, but the file it names lives
 * inside ONE operation's scratch directory -- and every exit path deletes that
 * directory. So the row says "this video is downloaded" while the file belongs
 * to whichever job or re-cut happens to be holding it.
 *
 * Reading it from a different operation is the race: a re-cut that adopted a
 * running job's download lost it the moment that job finished and cleaned up,
 * failing mid-render on a file it never created. Both queues poll
 * independently, so a job and a re-cut of the same source really can overlap.
 *
 * The fix is to only reuse what we created ourselves. Nothing is lost by it:
 * cleanup() nulls the column on every successful job, so a later operation
 * re-downloads anyway -- the only window where another operation could ever
 * read this path was the racy one.
 */
import { resolve, sep } from 'node:path'

/**
 * Does `scratchPath` live inside `workDir`?
 *
 * Not a bare startsWith: "/work/job-1" is a prefix of "/work/job-10", so the
 * naive version lets one job claim another's download and delete it on the way
 * out -- the very bug this exists to stop. Both sides are resolved first so
 * `..` cannot walk out of the directory it appears to be in.
 */
export function ownsScratch(scratchPath: string, workDir: string): boolean {
  if (!scratchPath) return false

  const file = resolve(scratchPath)
  const dir = resolve(workDir)

  // The directory is not a file inside itself.
  if (file === dir) return false

  return file.startsWith(dir + sep)
}
