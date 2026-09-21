import { z } from 'zod'
import { resolve } from 'node:path'

const schema = z.object({
  DATABASE_URL: z.string().min(1),

  S3_ENDPOINT: z.string().min(1),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),

  OPENROUTER_API_KEY: z.string().min(1, 'OPENROUTER_API_KEY is required to pick clip ranges'),
  OPENROUTER_BASE_URL: z
    .string()
    .default('https://openrouter.ai/api/v1')
    .transform((v) => v.replace(/\/+$/, '')),
  OPENROUTER_MODEL: z.string().default('google/gemini-2.5-flash'),

  WORK_DIR: z.string().default('./.work'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(1),
  WHISPER_MODEL: z.string().default('base'),
  WHISPER_LANGUAGE: z.string().optional(),
  WHISPER_THREADS: z.coerce.number().int().min(1).default(4),
  MIN_FREE_DISK_GB: z.coerce.number().default(5),
  YTDLP_MAX_AGE_DAYS: z.coerce.number().default(60),
  PREFER_YOUTUBE_SUBTITLES: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
  console.error(`Invalid environment:\n${issues}\n\nCopy .env.example to .env and fill it in.`)
  process.exit(1)
}

export const env = {
  ...parsed.data,
  WORK_DIR: resolve(parsed.data.WORK_DIR),
}
