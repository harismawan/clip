/** Database rows -> wire DTOs. The only place that knows the terse clip field
 *  names the prototype's components expect. */
import type { Video, Clip, Render, Job } from '../../shared/schema.ts'
import type { ClipDTO, JobDTO, RenderDTO, SourceDTO, Ratio } from '../../shared/types.ts'
import { fmtDuration, estimateEta, buildMeta } from '../../shared/format.ts'
import { mediaUrl, RATIOLESS } from '../../shared/mediaToken.ts'
import { env } from './env.ts'

/**
 * @param signWithClipId a clip of this video the caller owns, used to sign the
 *   full-length asset URLs. Omitted where there is no clip to sign with (the
 *   analyse screen, the projects list), and then those fields stay undefined --
 *   nothing that needs them is on screen there anyway.
 */
export function toSourceDTO(v: Video, clipCount = 12, signWithClipId?: string): SourceDTO {
  return {
    videoId: v.id,
    platform: v.platform,
    title: v.title,
    length: fmtDuration(v.durationSeconds),
    durationSeconds: v.durationSeconds,
    meta: buildMeta({
      uploader: v.uploader,
      publishedAt: v.publishedAt,
      maxHeight: v.maxHeight,
    }),
    eta: estimateEta(v.durationSeconds, clipCount),
    thumbnailUrl: v.thumbnailUrl,
    // Ratio-independent, like the per-clip proxy, so signed with RATIOLESS.
    proxyUrl:
      v.proxyKey && signWithClipId
        ? mediaUrl(env.PUBLIC_API_URL, env.API_TOKEN, signWithClipId, RATIOLESS, 'source')
        : null,
    stripUrl:
      v.stripKey && signWithClipId
        ? mediaUrl(env.PUBLIC_API_URL, env.API_TOKEN, signWithClipId, RATIOLESS, 'sourcestrip')
        : null,
    peaks: v.peaks ?? null,
  }
}

/**
 * Build signed media URLs for every ready render.
 *
 * Signing is a local HMAC, not a network call, so this stays synchronous even
 * for a job with 24 clips across 3 ratios.
 */
export function toClipDTOs(clips: Clip[], renders: Render[]): ClipDTO[] {
  const byClip = new Map<string, Render[]>()
  for (const r of renders) {
    const list = byClip.get(r.clipId)
    if (list) list.push(r)
    else byClip.set(r.clipId, [r])
  }

  return clips
    .slice()
    .sort((a, b) => a.idx - b.idx)
    .map((c) => {
      const out: Partial<Record<Ratio, RenderDTO>> = {}
      for (const r of byClip.get(c.id) ?? []) {
        const ready = r.status === 'ready'
        out[r.ratio as Ratio] = {
          ratio: r.ratio as Ratio,
          url: ready
            ? mediaUrl(env.PUBLIC_API_URL, env.API_TOKEN, c.id, r.ratio, 'video')
            : null,
          thumbUrl: ready
            ? mediaUrl(env.PUBLIC_API_URL, env.API_TOKEN, c.id, r.ratio, 'thumb')
            : null,
          width: r.width,
          height: r.height,
          sizeBytes: r.sizeBytes,
          status: r.status,
        }
      }
      return {
        id: c.id,
        idx: c.idx,
        t: c.title,
        s: c.startSeconds,
        e: c.endSeconds,
        sc: c.score,
        sn: c.snippet,
        cap: c.caption,
        line: c.subtitleLine,
        status: c.status,
        renders: out,

        // Ratio-independent: one proxy of the source window serves every crop,
        // so these are signed with the RATIOLESS placeholder.
        proxyUrl: c.proxyKey
          ? mediaUrl(env.PUBLIC_API_URL, env.API_TOKEN, c.id, RATIOLESS, 'proxy')
          : null,
        stripUrl: c.stripKey
          ? mediaUrl(env.PUBLIC_API_URL, env.API_TOKEN, c.id, RATIOLESS, 'strip')
          : null,
        peaks: c.peaks,
        win:
          c.windowStart !== null && c.windowSpan !== null
            ? { start: c.windowStart, span: c.windowSpan }
            : null,
      }
    })
}

export async function toJobDTO(
  job: Job,
  video: Video,
  clips: Clip[],
  renders: Render[],
): Promise<JobDTO> {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    error: job.error,
    clipCount: job.clipCount,
    lengthIdx: job.lengthPreset,
    formats: job.formats as Record<Ratio, boolean>,
    subs: job.burnSubtitles,
    source: toSourceDTO(video, job.clipCount, clips[0]?.id),
    clips: toClipDTOs(clips, renders),
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
  }
}
