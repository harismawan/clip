/** Seconds to a clock label: 42 -> "0:42", 4139 -> "1:08:59". */
export function fmt(sec: number): string {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = Math.floor(s % 60)
  const mm = h ? String(m).padStart(2, '0') : String(m)
  return (h ? `${h}:` : '') + mm + ':' + String(r).padStart(2, '0')
}

/** Epoch ms to a coarse "when", for the projects list. */
export function ago(ms: number, now = Date.now()): string {
  const mins = Math.floor((now - ms) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

/** Tailwind-friendly aspect ratio value for a clip format. */
export function aspect(ratio: string): string {
  return ratio.replace(':', '/')
}

/**
 * "1234567" -> "1.2 MB". Mirrors fmtBytes in shared/format.ts; the frontend
 * does not import across the workspace (see types.ts).
 */
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
