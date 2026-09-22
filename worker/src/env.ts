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

  /**
   * Retention for full-length source proxies. See shared/retention.ts.
   *
   * 6GB is sized for THIS box: ~20GB free on a disk shared with several other
   * applications, and a four-hour 1080p source can be an 8GB scratch download
   * on its own. At ~120MB per hour of source, 6GB is about 50 hours.
   */
  PROXY_BUDGET_GB: z.coerce.number().default(6),
  PROXY_TTL_DAYS: z.coerce.number().default(30),
  /** Never evict something opened this recently, even to get under budget. */
  PROXY_GRACE_MINUTES: z.coerce.number().default(30),
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
