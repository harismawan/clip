/**
 * Environment validation. Fails loudly at boot rather than at the first request,
 * because a missing API_TOKEN would otherwise silently leave the API open.
 */
import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(3004),
  HOST: z.string().default('127.0.0.1'),
  // No default and no empty string allowed: an unset token must stop the boot,
  // never fall back to "no auth".
  API_TOKEN: z.string().min(16, 'API_TOKEN must be at least 16 chars (openssl rand -hex 32)'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  /**
   * Publicly reachable origin of this API. Not the same as HOST:PORT when nginx
   * terminates TLS in front; signed media URLs are built against it, so getting
   * it wrong yields links the browser cannot reach.
   */
  PUBLIC_API_URL: z.string().default('http://localhost:3014'),

  S3_ENDPOINT: z.string().min(1),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),

  YTDLP_MAX_AGE_DAYS: z.coerce.number().default(60),
  MIN_FREE_DISK_GB: z.coerce.number().default(5),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
  console.error(`Invalid environment:\n${issues}\n\nCopy .env.example to .env and fill it in.`)
  process.exit(1)
}

export const env = parsed.data

export const corsOrigins = env.CORS_ORIGIN.split(',').map((s) => s.trim())
