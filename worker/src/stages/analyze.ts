/**
 * Pick interesting ranges from the transcript, via OpenRouter.
 *
 * The model is given the TRANSCRIPT WITH TIMESTAMPS, never the video. That is
 * deliberate: shown a video, Gemini emits MM:SS, which is ambiguous past one
 * hour and silently yields clips past the end of the source (a trap documented
 * in clipper's unbuilt cutlist.py design). Working from segments we supplied,
 * it returns float seconds and the ambiguity cannot arise.
 *
 * Nothing returned here is trusted: see ranges.ts.
 */
import { z } from 'zod'
import { env } from '../env.ts'
import { LENGTH_PRESETS } from '../../../shared/types.ts'
import type { TranscriptSegment } from '../../../shared/schema.ts'
import type { Candidate } from '../ranges.ts'
import { renderTranscript, extractJson } from '../parse.ts'

const responseSchema = z.object({
  clips: z
    .array(
      z.object({
        title: z.string(),
        start: z.number(),
        end: z.number(),
        score: z.number(),
        snippet: z.string().optional().default(''),
        caption: z.string().optional().default(''),
        line: z.string().optional().default(''),
      }),
    )
    .default([]),
})

const jsonSchema = {
  type: 'object',
  properties: {
    clips: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Punchy headline for the moment, max 60 chars' },
          start: { type: 'number', description: 'Start time in seconds' },
          end: { type: 'number', description: 'End time in seconds' },
          score: { type: 'number', description: 'Hook strength 0-100' },
          snippet: { type: 'string', description: 'Short transcript excerpt from the moment' },
          caption: { type: 'string', description: 'Suggested social caption, one sentence' },
          line: { type: 'string', description: 'The single most quotable phrase, max 40 chars' },
        },
        required: ['title', 'start', 'end', 'score', 'snippet', 'caption', 'line'],
        additionalProperties: false,
      },
    },
  },
  required: ['clips'],
  additionalProperties: false,
} as const

export interface AnalyzeOptions {
  segments: TranscriptSegment[]
  durationSeconds: number
  lengthIdx: number
  count: number
  title: string
  signal?: AbortSignal
}

export async function analyze(opts: AnalyzeOptions): Promise<Candidate[]> {
  const preset = LENGTH_PRESETS[opts.lengthIdx] ?? LENGTH_PRESETS[1]
  const transcript = renderTranscript(opts.segments)

  // Ask for extra candidates: validation drops overlaps and out-of-window
  // ranges, so requesting exactly `count` reliably under-delivers.
  const ask = Math.min(40, Math.ceil(opts.count * 1.8))

  const prompt = [
    `You are selecting short vertical clips from a long video for TikTok, Reels and Shorts.`,
    ``,
    `Video title: ${opts.title}`,
    `Total duration: ${opts.durationSeconds.toFixed(0)} seconds.`,
    ``,
    `Below is the transcript. Each line is "[start_seconds] text".`,
    ``,
    transcript,
    ``,
    `Find the ${ask} most compelling standalone moments.`,
    ``,
    `Rules:`,
    `- start and end are SECONDS (decimal numbers), measured from the beginning of the video.`,
    `- Every clip must be between ${preset.min} and ${preset.max} seconds long.`,
    `- end must never exceed ${opts.durationSeconds.toFixed(0)}.`,
    `- Clips must not overlap each other.`,
    `- Prefer moments that stand alone without setup: a surprising claim, a strong`,
    `  opinion, a concrete story, a punchline, or an assumption being broken.`,
    `- Avoid intros, sponsor reads, outros and filler.`,
    `- score is 0-100 for how well the moment hooks a scrolling viewer.`,
    `- snippet: a short verbatim excerpt from the transcript in that range.`,
    `- caption: one sentence to post alongside the clip.`,
    `- line: the single most quotable phrase from the moment, at most 40 characters.`,
    `- Write title, caption and line in the same language as the transcript.`,
  ].join('\n')

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal: opts.signal,
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'X-Title': 'clip-pipeline',
    },
    body: JSON.stringify({
      model: env.OPENROUTER_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'clips', strict: true, schema: jsonSchema },
      },
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`OpenRouter returned ${res.status}: ${body.slice(0, 300)}`)
  }

  const payload = (await res.json()) as any
  const content = payload?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('OpenRouter returned an empty response.')
  }

  const parsed = responseSchema.safeParse(JSON.parse(extractJson(content)))
  if (!parsed.success) {
    throw new Error(`OpenRouter returned unusable JSON: ${parsed.error.issues[0]?.message}`)
  }

  return parsed.data.clips.map((c) => ({
    title: c.title,
    start: c.start,
    end: c.end,
    score: c.score,
    snippet: c.snippet,
    caption: c.caption,
    line: c.line,
  }))
}
