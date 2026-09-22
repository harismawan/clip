/**
 * Editor assets for the WHOLE source, so manual mode can put the timeline
 * window anywhere in the video.
 *
 * The per-clip assets next door cover 150 seconds around one clip, which is all
 * the editor could ever show while its window was pinned. Unpinning it needs
 * something that covers the lot -- but not the original: the editor scrubs a
 * 240p proxy today and scrubs a 240p proxy in manual mode, and the render path
 * re-downloads the source anyway. ~120MB per hour instead of gigabytes.
 *
 * Three ffmpeg passes, the same three editorAssets.ts runs, minus the window.
 */
import { join } from 'node:path'
import { run, runBinary } from '../../../shared/proc.ts'
import { peaksFromPcm } from './editorAssets.ts'

/**
 * Frames in the overview filmstrip.
 *
 * Fixed, not per-second: this strip's job is "where am I in the video", and at
 * 80px each 120 frames is a 9600px sprite -- comfortably inside the 16384px
 * limit browsers put on a single image, which a per-second strip would blow
 * through before the source reached three minutes.
 */
export const OVERVIEW_FRAMES = 120

/** PCM sample rate for the peaks pass. Low, because only envelope shape matters. */
const PEAK_RATE = 8000

/**
 * One waveform bucket per second of source.
 *
 * The density is load-bearing, not arbitrary: the per-clip waveform is 150
 * buckets over a 150-second window, so holding one-per-second here lets the
 * same array serve both timelines. The overview downsamples it in the browser,
 * and the detail band slices the 150 values its window covers -- the exact
 * numbers a per-clip build would have produced. Change this and the detail band
 * silently shows the wrong stretch of audio.
 */
export function sourceBuckets(durationSeconds: number): number {
  return Math.max(1, Math.round(durationSeconds))
}

export interface SourceAssets {
  proxyPath: string
  stripPath: string
  peaks: number[]
}

export async function buildSourceAssets(opts: {
  sourcePath: string
  workDir: string
  durationSeconds: number
}): Promise<SourceAssets> {
  const proxyPath = join(opts.workDir, 'source-proxy.mp4')
  const stripPath = join(opts.workDir, 'source-strip.jpg')

  await run([
    'ffmpeg',
    '-nostdin',
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    opts.sourcePath,
    '-vf',
    // -2 keeps width even, which yuv420p requires.
    'scale=-2:240',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '32',
    '-pix_fmt',
    'yuv420p',
    // Keyframe every second. Over a four-hour timeline this is what makes a
    // dropped playhead land where it was dropped rather than seconds earlier.
    '-g',
    '25',
    '-c:a',
    'aac',
    '-b:a',
    '48k',
    '-ac',
    '1',
    // Load-bearing: without the moov atom at the front the browser cannot seek
    // over range requests, and on a 400MB proxy that is the whole feature.
    '-movflags',
    '+faststart',
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    proxyPath,
  ])

  // From the proxy, not the source: it is already 240p, so this costs almost
  // nothing next to decoding the original a second time.
  const fps = OVERVIEW_FRAMES / Math.max(1, opts.durationSeconds)
  await run([
    'ffmpeg',
    '-nostdin',
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    proxyPath,
    '-vf',
    `fps=${fps},scale=-2:45,tile=${OVERVIEW_FRAMES}x1`,
    '-frames:v',
    '1',
    '-q:v',
    '5',
    stripPath,
  ])

  return { proxyPath, stripPath, peaks: await peaksOf(proxyPath, opts.durationSeconds) }
}

/**
 * Decode the proxy's audio and bucket it, one bucket per second.
 *
 * A silent source has no audio stream, and `-map 0:a?` means the proxy may have
 * none either. ffmpeg fails rather than producing zero bytes, so that answers
 * with a flat waveform instead of taking the whole build down -- the same
 * posture the per-clip version takes.
 */
async function peaksOf(path: string, durationSeconds: number): Promise<number[]> {
  const buckets = sourceBuckets(durationSeconds)
  try {
    const { stdout } = await runBinary([
      'ffmpeg',
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      path,
      '-vn',
      '-ac',
      '1',
      '-ar',
      String(PEAK_RATE),
      '-f',
      's16le',
      '-',
    ])
    return peaksFromPcm(stdout, buckets)
  } catch {
    return Array.from({ length: buckets }, () => 0)
  }
}
