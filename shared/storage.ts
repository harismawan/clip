/**
 * Routes object reads and writes to the backend that actually holds them.
 *
 * Storage is a list, not an endpoint. One backend is the active write target;
 * every backend stays readable forever, so a clip rendered before the writes
 * moved still plays. The row that owns a key records which backend holds it
 * (`renders.storage`), so a read consults a column it already loaded rather than
 * probing each backend in turn.
 *
 * A factory with injected dependencies, like `makeS3` below it -- passing the
 * row loader and the credential lookup in keeps this file free of both database
 * and env coupling, and makes every rule here testable without either.
 */
import { makeS3, type S3 } from './s3.ts'

/** A backend as the registry stores it. Deliberately holds no credentials. */
export interface BackendRow {
  id: string
  label: string
  endpoint: string | null
  region: string
  bucket: string
  pathStyle: boolean
  isActive: boolean
}

export interface Credentials {
  accessKey: string
  secretKey: string
}

/** One object to delete, and the backend holding it. */
export interface StoredObject {
  storage: string
  key: string
}

/**
 * The env vars holding a backend's credentials.
 *
 * Derivation is deterministic so the management script can print the exact two
 * lines to paste. A mismatch here surfaces as "credentials missing" and sends
 * the reader hunting in the wrong place, which is why it is a named function
 * with its own test rather than an inline template string.
 */
export function envNames(id: string): { accessKey: string; secretKey: string } {
  const slug = id.toUpperCase().replace(/-/g, '_')
  return {
    accessKey: `STORAGE_${slug}_ACCESS_KEY`,
    secretKey: `STORAGE_${slug}_SECRET_KEY`,
  }
}

/** The slice of an S3 client this module needs; widened in tests. */
type Client = Pick<S3, 'bucket'> & { deleteMany: (keys: string[]) => Promise<void> }

export interface StorageDeps {
  /** Loads the registry. Called at most once per TTL. */
  load: () => Promise<BackendRow[]>
  credentials: (id: string) => Credentials | null
  /** Overridden in tests; defaults to a real S3 client. */
  makeClient?: (row: BackendRow, creds: Credentials) => Client
  ttlMs?: number
  now?: () => number
}

const DEFAULT_TTL_MS = 30_000

/**
 * Two backends are the same client only if every connection field matches.
 * Keyed on this rather than on the id alone, so editing a backend's bucket
 * cannot leave a process still writing to the previous one.
 */
function fingerprint(row: BackendRow): string {
  return [row.id, row.endpoint ?? '', row.region, row.bucket, row.pathStyle].join('|')
}

export function makeStorage(deps: StorageDeps) {
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS
  const now = deps.now ?? Date.now
  const build =
    deps.makeClient ??
    ((row: BackendRow, creds: Credentials) =>
      makeS3({
        // Real AWS is addressed by region; only MinIO and friends need an endpoint.
        endpoint: row.endpoint ?? `https://s3.${row.region}.amazonaws.com`,
        region: row.region,
        bucket: row.bucket,
        accessKey: creds.accessKey,
        secretKey: creds.secretKey,
        forcePathStyle: row.pathStyle,
      }) as unknown as Client)

  let rows: BackendRow[] = []
  let loadedAt = -Infinity
  let inFlight: Promise<BackendRow[]> | null = null
  const clients = new Map<string, { print: string; client: Client }>()

  async function registry(): Promise<BackendRow[]> {
    if (now() - loadedAt < ttlMs) return rows
    // Collapse a stampede: several jobs finishing at once would otherwise each
    // fire their own SELECT against the same expired cache.
    inFlight ??= deps
      .load()
      .then((loaded) => {
        rows = loaded
        loadedAt = now()
        return loaded
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  function clientFor(row: BackendRow): Client {
    const creds = deps.credentials(row.id)
    if (!creds) {
      const names = envNames(row.id)
      throw new Error(
        `Storage backend "${row.id}" has no credentials. ` +
          `Set ${names.accessKey} and ${names.secretKey} in .env, then restart.`,
      )
    }

    const print = fingerprint(row)
    const cached = clients.get(row.id)
    if (cached && cached.print === print) return cached.client

    const client = build(row, creds)
    clients.set(row.id, { print, client })
    return client
  }

  return {
    /** Every registered backend, for the management script and startup checks. */
    async list(): Promise<BackendRow[]> {
      return registry()
    },

    /**
     * The write target. Only the worker needs this -- the API reads and deletes
     * by the row's own storage id -- so a broken active backend stops new jobs
     * rendering without taking the website down.
     */
    async active(): Promise<{ id: string; s3: S3 }> {
      const row = (await registry()).find((r) => r.isActive)
      if (!row) {
        throw new Error(
          'No active storage backend. Run: bun run storage activate <id>',
        )
      }
      return { id: row.id, s3: clientFor(row) as unknown as S3 }
    },

    /** A specific backend, for reading or deleting an object already written. */
    async get(id: string): Promise<S3> {
      const row = (await registry()).find((r) => r.id === id)
      if (!row) {
        // Never fall back to the active backend: that would read the wrong
        // bucket and report a missing object rather than a misconfiguration.
        throw new Error(`Unknown storage backend "${id}".`)
      }
      return clientFor(row) as unknown as S3
    },

    /**
     * Delete objects that may live in different backends.
     *
     * Takes the backend id per object rather than a flat key list, because the
     * flat version fails silently: keys aimed at the wrong backend delete
     * nothing and still report success, leaving objects orphaned while the
     * database insists they are gone.
     */
    async deleteMany(items: StoredObject[]): Promise<void> {
      const byBackend = new Map<string, string[]>()
      for (const item of items) {
        const keys = byBackend.get(item.storage)
        if (keys) keys.push(item.key)
        else byBackend.set(item.storage, [item.key])
      }

      for (const [id, keys] of byBackend) {
        try {
          const client = await this.get(id)
          await (client as unknown as Client).deleteMany(keys)
        } catch (e) {
          // One unreachable backend must not abort the rest: deleting an
          // account has to remove what it can, and a retired backend being
          // down is not a reason to keep the other objects.
          console.error(
            `[storage] could not delete ${keys.length} object(s) from "${id}": ` +
              `${(e as Error).message}`,
          )
        }
      }
    },
  }
}

export type Storage = ReturnType<typeof makeStorage>
