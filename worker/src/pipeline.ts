/**
 * The job pipeline: download -> transcribe -> analyse -> render -> finalize.
 *
 * Every stage boundary re-checks cancellation and reports progress. Expensive
 * intermediate results (the download, the transcript) are keyed to the video
 * rather than the job so a regenerate or a re-cut does not pay for them twice.
 */
import { join } from 'node:path'
import { mkdir, rm, access, readFile } from 'node:fs/promises'
import { eq, desc } from 'drizzle-orm'
import { db, jobs, videos, transcripts, clips, renders } from './db.ts'
import { env } from './env.ts'
import { report, setStatus, assertNotCancelled, CancelledError, forgetJob } from './progress.ts'
import { assertYtdlpFresh, assertDiskSpace, download, probe } from '../../shared/ytdlp.ts'
import { transcribe } from './stages/transcribe.ts'
import { analyze } from './stages/analyze.ts'
import { renderClip } from './stages/render.ts'
import { buildEditorAssets } from './stages/editorAssets.ts'
import { validateRanges, textInRange } from './ranges.ts'
import { wrapHookLine } from './srt.ts'
import { ownsScratch } from './scratch.ts'
import { keys, storage } from './db.ts'
import { RATIOS } from '../../shared/types.ts'
import type { Ratio } from '../../shared/types.ts'
import type { TranscriptSegment } from '../../shared/schema.ts'
import { tryFetchYouTubeSubtitles } from './youtube_subs.ts'
import type { S3 } from '../../shared/s3.ts'

export async function processJob(jobId: string): Promise<void> {
  const workDir = join(env.WORK_DIR, jobId)

  try {
    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1)
    if (!job) throw new Error(`Job ${jobId} no longer exists`)
    if (job.status === 'cancelled') throw new CancelledError()

    const [video] = await db.select().from(videos).where(eq(videos.id, job.videoId)).limit(1)
    if (!video) throw new Error('Source video row is missing')

    // Resolved once, before the download: a job that has nowhere to put its
    // output should fail in a second rather than after 40 minutes of work. One
    // backend per job also means flipping the active target mid-render leaves
    // this job whole instead of scattered across two buckets.
    const store = await storage.active()

    await setStatus(jobId, {
      status: 'downloading',
      stage: 'Starting',
      progress: 0,
      error: null,
      startedAt: new Date(),
    })

    await mkdir(workDir, { recursive: true })

    // --- 1. download ---------------------------------------------------------
    await assertNotCancelled(jobId)
    const sourcePath = await ensureDownloaded(jobId, video, workDir)

    // --- 2. transcribe -------------------------------------------------------
    await assertNotCancelled(jobId)
    const segments = await ensureTranscript(
      jobId,
      video.id,
      video.url,
      sourcePath,
      video.durationSeconds,
      workDir,
      store,
    )

    // --- 3. analyse ----------------------------------------------------------
    await assertNotCancelled(jobId)
    await setStatus(jobId, { status: 'analyzing', stage: 'Scoring moments', progress: 48 })

    const candidates = await analyze({
      segments,
      durationSeconds: video.durationSeconds,
      lengthIdx: job.lengthPreset,
      count: job.clipCount,
      title: video.title,
    })

    const ranges = validateRanges(candidates, {
      durationSeconds: video.durationSeconds,
      lengthIdx: job.lengthPreset,
      count: job.clipCount,
      segments,
    })

    if (ranges.length === 0) {
      throw new Error(
        'No usable moments were found in that video. Try a different clip length, or a source with more speech.',
      )
    }

    // Replace any previous clips (a regenerate re-enters here).
    await db.delete(clips).where(eq(clips.jobId, jobId))

    const clipRows = await db
      .insert(clips)
      .values(
        ranges.map((r, i) => ({
          jobId,
          idx: i,
          title: r.title,
          startSeconds: r.start,
          endSeconds: r.end,
          score: r.score,
          snippet: r.snippet || textInRange(segments, r.start, r.end).slice(0, 220),
          caption: r.caption || r.title,
          subtitleLine: wrapHookLine(r.line || r.title),
          status: 'pending' as const,
        })),
      )
      .returning()

    await setStatus(jobId, {
      status: 'rendering',
      stage: `Rendering 0 of ${clipRows.length}`,
      progress: 60,
    })

    // --- 4. render -----------------------------------------------------------
    const ratios = RATIOS.filter((r) => (job.formats as Record<string, boolean>)[r])
    for (const [i, clip] of clipRows.entries()) {
      await assertNotCancelled(jobId)
      await report(jobId, 'rendering', `Rendering ${i + 1} of ${clipRows.length}`, i / clipRows.length)

      await renderClip({
        jobId,
        clip,
        sourcePath,
        workDir,
        ratios,
        segments,
        burnSubtitles: job.burnSubtitles,
        store,
      })

      await storeEditorAssets(clip, sourcePath, workDir, video.durationSeconds, store)
    }

    // --- 5. finalize ---------------------------------------------------------
    await setStatus(jobId, { status: 'rendering', stage: 'Cleaning up', progress: 96 })
    await cleanup(workDir, video.id)

    await setStatus(jobId, {
      status: 'completed',
      stage: 'Done',
      progress: 100,
      error: null,
      completedAt: new Date(),
    })
  } catch (e) {
    // Scratch is deleted on every exit path. Leaving a multi-GB download behind
    // after a failure is how 14GB of free disk disappears in three attempts.
    await rm(workDir, { recursive: true, force: true }).catch(() => {})

    if (e instanceof CancelledError) {
      await setStatus(jobId, {
        status: 'cancelled',
        stage: 'Cancelled',
        completedAt: new Date(),
      }).catch(() => {})
      return
    }

    const message = (e as Error).message ?? 'Unknown error'
    console.error(`[pipeline] job ${jobId} failed:`, message)
    await setStatus(jobId, {
      status: 'failed',
      stage: 'Failed',
      error: message.slice(0, 1000),
      completedAt: new Date(),
    }).catch(() => {})
  } finally {
    forgetJob(jobId)
  }
}

/**
 * Download unless THIS operation already left a usable file behind.
 *
 * The ownership check is the whole point. `videos.scratch_path` is global but
 * names a file inside one operation's scratch directory, and every exit path
 * deletes that directory -- so adopting another operation's download means
 * rendering from a file that vanishes when its owner finishes. The process and
 * re-cut queues poll independently, so a job and a re-cut of the same source
 * really do overlap.
 *
 * Nothing is given up by scoping it: cleanup() nulls the column after every
 * successful job, so a later operation re-downloads regardless. The only window
 * in which another operation could ever have read this path was the racy one.
 */
async function ensureDownloaded(
  jobId: string,
  video: typeof videos.$inferSelect,
  workDir: string,
): Promise<string> {
  if (
    video.scratchPath &&
    ownsScratch(video.scratchPath, workDir) &&
    (await fileExists(video.scratchPath))
  ) {
    await report(jobId, 'downloading', 'Using cached download', 1)
    return video.scratchPath
  }

  await assertYtdlpFresh(env.YTDLP_MAX_AGE_DAYS)

  // Re-probe for a current size estimate: the disk guard is only useful with a
  // number, and the stored row may predate the current format availability.
  const info = await probe(video.url).catch(() => null)
  await assertDiskSpace(env.WORK_DIR, info?.estimatedBytes ?? null, env.MIN_FREE_DISK_GB)

  await setStatus(jobId, { status: 'downloading', stage: 'Downloading source', progress: 0 })

  const path = await download(video.url, workDir, (f) => {
    void report(jobId, 'downloading', 'Downloading source', f)
  })

  await db.update(videos).set({ scratchPath: path }).where(eq(videos.id, video.id))
  return path
}

/** Reuse an existing transcript for this video; otherwise produce one. */
async function ensureTranscript(
  jobId: string,
  videoId: string,
  videoUrl: string,
  sourcePath: string,
  durationSeconds: number,
  workDir: string,
  store: { id: string; s3: S3 },
): Promise<TranscriptSegment[]> {
  const [existing] = await db
    .select()
    .from(transcripts)
    .where(eq(transcripts.videoId, videoId))
    .orderBy(desc(transcripts.createdAt))
    .limit(1)

  if (existing && existing.segments.length > 0) {
    await report(jobId, 'transcribing', 'Using cached transcript', 1)
    return existing.segments
  }

  await setStatus(jobId, { status: 'transcribing', stage: 'Transcribing', progress: 24 })

  // 1. Try fetching auto-captions / subtitles directly (if enabled, instant & high accuracy)
  let result = env.PREFER_YOUTUBE_SUBTITLES
    ? await tryFetchYouTubeSubtitles(videoUrl, workDir, `[pipeline ${jobId}]`)
    : null

  // 2. Fallback to local Whisper if subtitles are unavailable
  if (!result) {
    result = await transcribe(sourcePath, workDir, durationSeconds, (f) => {
      void report(jobId, 'transcribing', 'Transcribing', f)
    })
  }

  let srtKey: string | null = null
  if (result.srt.trim()) {
    srtKey = keys.srt(videoId)
    await store.s3
      .upload(srtKey, Buffer.from(result.srt, 'utf8'), 'application/x-subrip')
      .catch((e: Error) => {
      // The sidecar SRT is a convenience; losing it must not fail the job.
        console.warn('[pipeline] could not upload transcript SRT:', e.message)
        srtKey = null
      })
  }

  await db.insert(transcripts).values({
    videoId,
    language: result.language,
    srtKey,
    // Written with the key, so the two can never disagree about where it is.
    storage: store.id,
    segments: result.segments,
  })

  return result.segments
}

/**
 * Build and store the editor's proxy, filmstrip and waveform for one clip.
 *
 * Best effort, by design. These exist so the editor screen has something to
 * play; losing them costs a placeholder and a note, and failing a forty-minute
 * render over a filmstrip would be absurd. The same posture the sidecar SRT
 * upload takes.
 */
async function storeEditorAssets(
  clip: typeof clips.$inferSelect,
  sourcePath: string,
  workDir: string,
  durationSeconds: number,
  store: { id: string; s3: S3 },
): Promise<void> {
  try {
    const built = await buildEditorAssets({
      sourcePath,
      workDir,
      stem: `clip-${clip.idx}`,
      startSeconds: clip.startSeconds,
      endSeconds: clip.endSeconds,
      durationSeconds,
    })

    const proxyKey = keys.proxy(clip.jobId, clip.id)
    const stripKey = keys.strip(clip.jobId, clip.id)

    const [mp4, jpg] = await Promise.all([
      readFile(built.proxyPath),
      readFile(built.stripPath),
    ])

    await Promise.all([
      store.s3.upload(proxyKey, mp4, 'video/mp4'),
      store.s3.upload(stripKey, jpg, 'image/jpeg'),
    ])

    await db
      .update(clips)
      .set({
        proxyKey,
        // The Range header the editor's scrubber depends on needs a length, and
        // the storage interface has no HEAD -- so record it here, at the one
        // moment the size is known for free.
        proxyBytes: mp4.byteLength,
        stripKey,
        peaks: built.peaks,
        windowStart: built.window.start,
        windowSpan: built.window.span,
        // Written with the keys, so the two can never disagree about where they are.
        assetStorage: store.id,
      })
      .where(eq(clips.id, clip.id))

    await Promise.all([
      rm(built.proxyPath, { force: true }).catch(() => {}),
      rm(built.stripPath, { force: true }).catch(() => {}),
    ])
  } catch (e) {
    console.warn(`[pipeline] editor assets for clip ${clip.id} failed:`, (e as Error).message)
  }
}

/** Delete scratch and forget the cached download path. */
async function cleanup(workDir: string, videoId: string): Promise<void> {
  await rm(workDir, { recursive: true, force: true }).catch(() => {})
  await db.update(videos).set({ scratchPath: null }).where(eq(videos.id, videoId))
}

/**
 * Re-cut one clip: re-render the existing range from a freshly downloaded
 * source. Reuses the transcript, so this costs a download plus one render
 * rather than a full re-analysis.
 */
export async function recutClip(jobId: string, clipId: string): Promise<void> {
  const workDir = join(env.WORK_DIR, `recut-${clipId}`)

  try {
    const [clip] = await db.select().from(clips).where(eq(clips.id, clipId)).limit(1)
    if (!clip) throw new Error('Clip no longer exists')

    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1)
    if (!job) throw new Error('Job no longer exists')

    const [video] = await db.select().from(videos).where(eq(videos.id, job.videoId)).limit(1)
    if (!video) throw new Error('Source video row is missing')

    const [transcript] = await db
      .select()
      .from(transcripts)
      .where(eq(transcripts.videoId, video.id))
      .orderBy(desc(transcripts.createdAt))
      .limit(1)

    if (!transcript) throw new Error('No transcript for this video; regenerate the job instead.')

    const store = await storage.active()

    await mkdir(workDir, { recursive: true })
    const sourcePath = await ensureDownloaded(jobId, video, workDir)

    // Drop the previous renders, in storage as well as in the database. Each row
    // carries its own backend: an old render may predate the current write
    // target, and aiming its keys at the wrong bucket would delete nothing while
    // reporting success.
    const old = await db.select().from(renders).where(eq(renders.clipId, clipId))
    const objects = old.flatMap((r) =>
      [r.s3Key, r.thumbKey].filter(Boolean).map((key) => ({ storage: r.storage, key: key as string })),
    )
    // The editor assets go too. A re-cut usually follows a saved trim, which
    // moves clip.startSeconds and therefore moves the window they cover, so
    // keeping them would leave the editor scrubbing the wrong stretch of source.
    objects.push(
      ...[clip.proxyKey, clip.stripKey]
        .filter(Boolean)
        .map((key) => ({ storage: clip.assetStorage, key: key as string })),
    )
    if (objects.length) await storage.deleteMany(objects)
    await db.delete(renders).where(eq(renders.clipId, clipId))

    await renderClip({
      jobId,
      clip,
      sourcePath,
      workDir,
      ratios: RATIOS.filter((r) => (job.formats as Record<string, boolean>)[r]) as Ratio[],
      segments: transcript.segments,
      burnSubtitles: job.burnSubtitles,
      store,
    })

    await storeEditorAssets(clip, sourcePath, workDir, video.durationSeconds, store)
  } catch (e) {
    const message = (e as Error).message ?? 'Unknown error'
    console.error(`[pipeline] recut ${clipId} failed:`, message)
    await db
      .update(clips)
      .set({ status: 'failed', error: message.slice(0, 500) })
      .where(eq(clips.id, clipId))
      .catch(() => {})
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
