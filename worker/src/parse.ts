/**
 * Worker-only parsing helpers.
 *
 * The prompt-shaping half of this file moved to shared/clipPrompt.ts when the
 * API process started building prompts of its own for the recommendation chat.
 * What is left reads a subprocess's stderr, which is nobody else's business.
 */

/**
 * whisper-ctranslate2 prints each segment as "[00:12.340 --> 00:15.220] text".
 * The end timestamp is how far through the audio it has got.
 */
export function parseWhisperProgress(line: string): number | null {
  const m = line.match(/-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d+)/)
  if (!m) return null
  const h = m[1] ? +m[1] : 0
  return h * 3600 + +m[2] * 60 + +m[3] + Number(`0.${m[4]}`)
}
