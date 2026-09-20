/** Display-string helpers. The API sends these pre-formatted so the source card
 *  renders identically to the prototype's fixtures. */

/** 7104 -> "1:58:24", 2712 -> "45:12". Matches the prototype's Source.length. */
export function fmtDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

/**
 * Rough wall-clock estimate for a whole job, in the prototype's "~6 min" style.
 *
 * Transcription dominates: whisper `base`, int8, 4 threads runs at roughly
 * 0.3x realtime. Download and render are smaller and roughly proportional.
 * This is a display hint, not a promise.
 */
export function estimateEta(durationSeconds: number, clipCount = 12): string {
  const seconds = durationSeconds * 0.4 + clipCount * 25 + 60
  const mins = Math.max(1, Math.round(seconds / 60))
  if (mins < 60) return `~${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m === 0 ? `~${h} hr` : `~${h} hr ${m} min`
}

/** Epoch ms -> "3 days ago". Mirrors the frontend's ago(). */
export function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  const units: [number, string][] = [
    [60, 'minute'],
    [3600, 'hour'],
    [86400, 'day'],
    [604800, 'week'],
    [2592000, 'month'],
  ]
  let label = 'minute'
  let div = 60
  for (const [seconds, name] of units) {
    if (s >= seconds) {
      div = seconds
      label = name
    }
  }
  const n = Math.floor(s / div)
  return `${n} ${label}${n === 1 ? '' : 's'} ago`
}

/** "YYYYMMDD" (yt-dlp's upload_date) -> epoch ms, or null if unparseable. */
export function parseUploadDate(d: string | null | undefined): number | null {
  if (!d || !/^\d{8}$/.test(d)) return null
  const y = +d.slice(0, 4)
  const m = +d.slice(4, 6)
  const day = +d.slice(6, 8)
  const t = Date.UTC(y, m - 1, day)
  return Number.isNaN(t) ? null : t
}

/**
 * Build the source card's meta line, e.g.
 * "channelname · posted last week · 1080p available".
 * Segments with no data are dropped rather than rendered empty.
 */
export function buildMeta(opts: {
  uploader?: string | null
  publishedAt?: string | null
  maxHeight?: number | null
  isLive?: boolean
}): string {
  const parts: string[] = []
  if (opts.uploader) parts.push(opts.uploader)

  const t = parseUploadDate(opts.publishedAt)
  if (t !== null) parts.push(`${opts.isLive ? 'streamed' : 'posted'} ${ago(t)}`)

  if (opts.maxHeight) parts.push(`${opts.maxHeight}p available`)

  return parts.join(' · ')
}

/**
 * Filename slug. Deliberately identical to clipper's slugify(), whose output the
 * clip browser reverses (`_` -> space) -- diverging would break that UI.
 */
export function slugify(s: string): string {
  return s
    .replace(/[^A-Za-z0-9-]/g, '_')
    .slice(0, 120)
    .replace(/_+$/, '')
}

/** "1234567" -> "1.2 MB". */
export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}
