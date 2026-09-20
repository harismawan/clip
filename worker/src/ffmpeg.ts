/**
 * ffmpeg / ffprobe wrappers.
 *
 * Conventions inherited from clipper/clip.sh, and they are load-bearing:
 *   - `-ss` goes BEFORE `-i` (fast seek). After `-i` it decodes from zero.
 *   - duration via `-t`, never `-to`: with a pre-input `-ss`, `-to` is
 *     interpreted against the original timeline, not the seek point.
 *   - audio is mapped `0:a?` so a silent source does not fail the encode.
 */
import { run, runStreaming } from '../../shared/proc.ts'

export async function probeDuration(path: string): Promise<number> {
  const { stdout } = await run([
    'ffprobe',
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    path,
  ])
  const n = Number(stdout.trim())
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Could not read duration of ${path}`)
  return n
}

export async function probeDimensions(path: string): Promise<{ width: number; height: number }> {
  const { stdout } = await run([
    'ffprobe',
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'csv=p=0',
    path,
  ])
  const [w, h] = stdout.trim().split(',').map(Number)
  if (!w || !h) throw new Error(`Could not read dimensions of ${path}`)
  return { width: w, height: h }
}

/**
 * 16 kHz mono mp3 for whisper.
 *
 * Whisper resamples to 16 kHz internally, so extracting at that rate costs no
 * accuracy and makes the file ~150x smaller than the video.
 */
export async function extractAudio(
  input: string,
  output: string,
  onProgress?: (fraction: number) => void,
  totalDuration?: number,
): Promise<string> {
  await runStreaming(
    [
      'ffmpeg',
      '-nostdin',
      '-loglevel',
      'error',
      '-stats',
      '-i',
      input,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'libmp3lame',
      '-q:a',
      '4',
      output,
      '-y',
    ],
    (line) => {
      if (!onProgress || !totalDuration) return
      const t = parseFfmpegTime(line)
      if (t !== null) onProgress(Math.min(1, t / totalDuration))
    },
  )
  return output
}

/** Cut [start, start+duration) with a stream copy. Fast; keyframe-aligned. */
export async function cut(
  input: string,
  output: string,
  start: number,
  duration: number,
): Promise<string> {
  await run([
    'ffmpeg',
    '-nostdin',
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(start),
    '-i',
    input,
    '-t',
    String(duration),
    '-c',
    'copy',
    '-avoid_negative_ts',
    'make_zero',
    output,
  ])
  return output
}

/**
 * Cut with re-encoding, for frame-accurate boundaries.
 *
 * A stream copy can only cut on keyframes, so boundaries drift a second or two.
 * That is fine for a 60-second clip but visibly wrong when the hook is the first
 * word, so the pipeline re-encodes.
 */
export async function cutAccurate(
  input: string,
  output: string,
  start: number,
  duration: number,
): Promise<string> {
  await run([
    'ffmpeg',
    '-nostdin',
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(start),
    '-i',
    input,
    '-t',
    String(duration),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    output,
  ])
  return output
}

/** Single JPEG poster frame, taken a beat into the clip to avoid a black first frame. */
export async function thumbnail(input: string, output: string, atSeconds = 1): Promise<string> {
  await run([
    'ffmpeg',
    '-nostdin',
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(atSeconds),
    '-i',
    input,
    '-frames:v',
    '1',
    '-q:v',
    '4',
    output,
  ])
  return output
}

/**
 * Static centre crop + scale, with optional burned subtitles.
 * The fallback path when speaker-tracking autocrop is unavailable or fails.
 */
export async function reframeStatic(
  input: string,
  output: string,
  outW: number,
  outH: number,
  subtitlePath?: string,
): Promise<string> {
  const { width, height } = await probeDimensions(input)

  // Crop the widest region matching the target aspect, then scale to size.
  let cropW = Math.round((height * outW) / outH)
  cropW += cropW % 2
  cropW = Math.min(cropW, width)
  let cropH = height
  if (cropW > width) {
    cropW = width
    cropH = Math.round((width * outH) / outW)
    cropH += cropH % 2
    cropH = Math.min(cropH, height)
  }
  const x = Math.max(0, Math.round((width - cropW) / 2))
  const y = Math.max(0, Math.round((height - cropH) / 2))

  const chain = [`crop=${cropW}:${cropH}:${x}:${y}`, `scale=${outW}:${outH}`]
  // Subtitles go AFTER scale: the ASS declares PlayRes equal to the output
  // size, so burning before the scale would resize the text along with it.
  if (subtitlePath) chain.push(subtitleFilter(subtitlePath))
  chain.push('setsar=1')

  await run([
    'ffmpeg',
    '-nostdin',
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    input,
    '-vf',
    chain.join(','),
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    output,
  ])
  return output
}

/**
 * Build a `subtitles=` filter argument.
 *
 * ffmpeg's filtergraph parser treats `:`, `,`, `'` and `\` as structure, so a
 * path containing any of them silently produces a broken graph rather than an
 * error. Escaping is mandatory, not defensive.
 */
export function subtitleFilter(path: string): string {
  const escaped = path.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
  return `subtitles='${escaped}'`
}

/** "frame= 123 fps=... time=00:01:23.45 ..." -> seconds, or null. */
export function parseFfmpegTime(line: string): number | null {
  const m = line.match(/time=(\d+):(\d{2}):(\d{2})\.(\d+)/)
  if (!m) return null
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + Number(`0.${m[4]}`)
}
