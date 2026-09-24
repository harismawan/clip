/**
 * "This video is loading", laid over the video's box.
 *
 * A clip is 5-20MB and the first frame can take seconds on a phone, during
 * which a bare <video> is a black rectangle that looks broken. Also shown again
 * while playback stalls to buffer, which looks exactly the same.
 *
 * Needs a positioned parent. role="status" so a screen reader hears it too.
 */
export function MediaSpinner({ label = 'Loading video…' }: { label?: string }) {
  return (
    <span
      role="status"
      className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black/35"
    >
      <span className="size-8 rounded-full border-[3px] border-white/25 border-t-white motion-safe:animate-spin" />
      <span className="text-[11.5px] font-medium text-white/80">{label}</span>
    </span>
  )
}
