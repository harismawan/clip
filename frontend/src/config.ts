/**
 * Card-level switches carried over from the design file, where they were
 * exposed as prototype props.
 */
export const FEATURES = {
  /**
   * Manual clipping: unpin the editor window so a cut can be taken from
   * anywhere in the source. Needs the full-length proxy, which is built on
   * demand and bounded by retention -- see the worker's sweepSourceProxies.
   */
  manualClip: true,
  /** Show the hook score badge on clip cards and in the editor header. */
  showHookScore: true,
  /** Show two lines of transcript under each clip title. */
  showTranscriptSnippet: true,
}
