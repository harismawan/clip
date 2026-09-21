/**
 * Object storage for the API: a resolver over the backend registry, not a
 * single client.
 *
 * The API never writes, so it never needs the active backend -- it reads and
 * deletes by the `storage` id recorded on the row that owns the key. That is
 * why a broken write target cannot take the website down.
 */
import { makeStorage, envNames, type BackendRow } from '../../shared/storage.ts'
import { db, storageBackends } from './db/index.ts'
import { env } from './env.ts'

/**
 * Credentials come from the environment, one pair per backend id, so a database
 * dump cannot carry them.
 *
 * `minio` falls back to the legacy S3_* pair: on the day the registry shipped,
 * `.env` had no STORAGE_* lines and every existing object was in MinIO. Without
 * this fallback the rollout would have needed an env edit to stay still.
 */
export function credentials(id: string) {
  const names = envNames(id)
  const accessKey = process.env[names.accessKey]
  const secretKey = process.env[names.secretKey]
  if (accessKey && secretKey) return { accessKey, secretKey }

  if (id === 'minio' && env.S3_ACCESS_KEY && env.S3_SECRET_KEY) {
    return { accessKey: env.S3_ACCESS_KEY, secretKey: env.S3_SECRET_KEY }
  }
  return null
}

export const storage = makeStorage({
  load: async (): Promise<BackendRow[]> => db.select().from(storageBackends),
  credentials,
})

/**
 * Warn about backends whose credentials are missing -- never exit.
 *
 * The API only reads, so a backend it cannot reach costs those clips and
 * nothing else. Refusing to start would turn one retired bucket into a total
 * outage. The worker takes the opposite view for the active backend, because it
 * genuinely cannot do its job without it.
 */
export async function warnAboutStorage(): Promise<void> {
  const rows = await storage.list().catch(() => [])
  for (const row of rows) {
    if (credentials(row.id)) continue
    const names = envNames(row.id)
    console.warn(
      `[storage] backend "${row.id}" has no credentials -- objects there will not serve. ` +
        `Set ${names.accessKey} and ${names.secretKey} in .env, then restart.`,
    )
  }
}

export { keys } from '../../shared/s3.ts'
