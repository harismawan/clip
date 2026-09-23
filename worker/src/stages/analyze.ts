/**
 * Pick interesting ranges from the transcript, via OpenRouter.
 *
 * Thin by design: the prompt lives in shared/clipPrompt.ts and the call in
 * shared/openrouter.ts, because the API process needs both for the
 * recommendation chat. All that is left here is binding the worker's env to
 * them, which is exactly the part the API must not share.
 *
 * Nothing returned here is trusted: see shared/clipRanges.ts.
 */
import { env } from '../env.ts'
import type { Candidate } from '../../../shared/clipRanges.ts'
import { buildAnalyzePrompt, type PromptOptions } from '../../../shared/clipPrompt.ts'
import { requestClips } from '../../../shared/openrouter.ts'

/** Everything buildAnalyzePrompt needs, plus the one field only the call uses. */
export interface AnalyzeOptions extends PromptOptions {
  signal?: AbortSignal
}

export async function analyze(opts: AnalyzeOptions): Promise<Candidate[]> {
  return requestClips({
    prompt: buildAnalyzePrompt(opts),
    signal: opts.signal,
    config: {
      apiKey: env.OPENROUTER_API_KEY,
      baseUrl: env.OPENROUTER_BASE_URL,
      model: env.OPENROUTER_MODEL,
    },
  })
}
