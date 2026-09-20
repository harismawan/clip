import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { env } from './env.ts'
import * as schema from '../../shared/schema.ts'
import { makeS3 } from '../../shared/s3.ts'

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  // Concurrency 1 means one in-flight job; a small pool is plenty and leaves
  // connections for the API.
  max: 5,
})

export const db = drizzle(pool, { schema })

export const s3 = makeS3({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  bucket: env.S3_BUCKET,
  accessKey: env.S3_ACCESS_KEY,
  secretKey: env.S3_SECRET_KEY,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
})

export * from '../../shared/schema.ts'
export { keys } from '../../shared/s3.ts'
