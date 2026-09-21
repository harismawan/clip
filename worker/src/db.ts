import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { env } from './env.ts'
import * as schema from '../../shared/schema.ts'
import { makeStorage, envNames, type BackendRow } from '../../shared/storage.ts'
import { storageBackends } from '../../shared/schema.ts'

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  // Concurrency 1 means one in-flight job; a small pool is plenty and leaves
  // connections for the API.
  max: 5,
})

export const db = drizzle(pool, { schema })

/**
 * Credentials live in the environment, one pair per backend id, so a database
 * dump cannot carry them. `minio` falls back to the legacy S3_* pair, which is
 * what let the registry ship without touching .env.
 */
function credentials(id: string) {
  const names = envNames(id)
  const accessKey = process.env[names.accessKey]
  const secretKey = process.env[names.secretKey]
  if (accessKey && secretKey) return { accessKey, secretKey }

  if (id === 'minio' && env.S3_ACCESS_KEY && env.S3_SECRET_KEY) {
    return { accessKey: env.S3_ACCESS_KEY, secretKey: env.S3_SECRET_KEY }
  }
  return null
}

/**
 * Object storage as a list of backends. The worker writes to whichever is
 * active and reads from whichever a row names.
 */
export const storage = makeStorage({
  load: async (): Promise<BackendRow[]> => db.select().from(storageBackends),
  credentials,
})

/**
 * Refuse to start when the active backend is unusable.
 *
 * The worker cannot do its job without somewhere to put the output, and
 * discovering that after a 40-minute transcription is exactly the failure
 * assertWhisperAvailable() exists to prevent. A missing INACTIVE backend is only
 * a warning: a retired bucket must not be able to stop new work.
 */
export async function assertStorageReady(): Promise<void> {
  const rows = await storage.list()

  for (const row of rows.filter((r) => !r.isActive)) {
    if (credentials(row.id)) continue
    const names = envNames(row.id)
    console.warn(
      `[storage] backend "${row.id}" has no credentials -- clips there cannot be re-cut. ` +
        `Set ${names.accessKey} and ${names.secretKey} in .env.`,
    )
  }

  // Throws with the exact env var names when the active one is unusable.
  await storage.active()
}

export * from '../../shared/schema.ts'
export { keys } from '../../shared/s3.ts'
