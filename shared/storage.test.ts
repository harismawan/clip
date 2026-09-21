/**
 * The storage resolver.
 *
 * Takes its database and its credential lookup as arguments, so every rule here
 * is testable without a Postgres or a network -- which matters, because the one
 * that bites hardest (grouping deletes by backend) fails SILENTLY in production:
 * aiming one backend's keys at another succeeds against keys that do not exist
 * there, reporting success while the real objects survive forever.
 */
import { test, expect, describe } from 'bun:test'
import { makeStorage, type BackendRow } from './storage.ts'

const MINIO: BackendRow = {
  id: 'minio',
  label: 'Local MinIO',
  endpoint: 'http://localhost:9020',
  region: 'us-east-1',
  bucket: 'clips',
  pathStyle: true,
  isActive: true,
}

const S3: BackendRow = {
  id: 's3-jkt',
  label: 'AWS Jakarta',
  endpoint: null,
  region: 'ap-southeast-3',
  bucket: 'clip-prod',
  pathStyle: false,
  isActive: false,
}

/** A load function plus a counter, so cache behaviour is observable. */
function fakeLoader(rows: BackendRow[]) {
  const state = { calls: 0, rows }
  return {
    state,
    load: async () => {
      state.calls++
      return state.rows
    },
  }
}

const creds = (id: string) => ({ accessKey: `${id}-key`, secretKey: `${id}-secret` })

describe('active backend', () => {
  test('resolves the row flagged active', async () => {
    const { load } = fakeLoader([MINIO, S3])
    const storage = makeStorage({ load, credentials: creds })
    expect((await storage.active()).id).toBe('minio')
  })

  test('throws a named error when nothing is active', async () => {
    const { load } = fakeLoader([{ ...MINIO, isActive: false }])
    const storage = makeStorage({ load, credentials: creds })
    // The message lands in jobs.error, where a user reads it.
    expect(storage.active()).rejects.toThrow(/no active storage backend/i)
  })

  test('throws when the active backend has no credentials', async () => {
    const { load } = fakeLoader([MINIO])
    const storage = makeStorage({ load, credentials: () => null })
    // Naming the env vars is the point: "access denied" sends you hunting.
    expect(storage.active()).rejects.toThrow(/STORAGE_MINIO_ACCESS_KEY/)
  })
})

describe('get by id', () => {
  test('resolves a backend that is not the active one', async () => {
    const { load } = fakeLoader([MINIO, S3])
    const storage = makeStorage({ load, credentials: creds })
    expect((await storage.get('s3-jkt')).bucket).toBe('clip-prod')
  })

  test('an unknown id is an error, not a silent fallback to active', async () => {
    const { load } = fakeLoader([MINIO])
    const storage = makeStorage({ load, credentials: creds })
    // Falling back would read the wrong bucket and report "not found".
    expect(storage.get('gone')).rejects.toThrow(/gone/)
  })
})

describe('client caching', () => {
  test('rows are loaded once within the TTL', async () => {
    const { state, load } = fakeLoader([MINIO, S3])
    const storage = makeStorage({ load, credentials: creds })
    await storage.active()
    await storage.get('s3-jkt')
    await storage.active()
    expect(state.calls).toBe(1)
  })

  test('rows reload once the TTL has passed', async () => {
    const { state, load } = fakeLoader([MINIO, S3])
    let now = 1_000_000
    const storage = makeStorage({ load, credentials: creds, ttlMs: 30_000, now: () => now })
    await storage.active()
    now += 30_001
    await storage.active()
    expect(state.calls).toBe(2)
  })

  test('the same backend hands back the same client', async () => {
    const { load } = fakeLoader([MINIO])
    const storage = makeStorage({ load, credentials: creds })
    expect(await storage.get('minio')).toBe(await storage.get('minio'))
  })

  test('editing a backend replaces its client rather than reusing the old one', async () => {
    const { state, load } = fakeLoader([MINIO])
    let now = 1_000_000
    const storage = makeStorage({ load, credentials: creds, ttlMs: 1000, now: () => now })
    const before = await storage.get('minio')

    state.rows = [{ ...MINIO, bucket: 'moved' }]
    now += 1001

    const after = await storage.get('minio')
    expect(after).not.toBe(before)
    expect(after.bucket).toBe('moved')
  })
})

describe('credentials', () => {
  test('minio falls back to the legacy keys, so the rollout needs no .env change', async () => {
    const { load } = fakeLoader([MINIO])
    // Only the legacy pair exists; STORAGE_MINIO_* is absent.
    const legacyOnly = (id: string) =>
      id === 'minio' ? { accessKey: 'legacy', secretKey: 'legacy-secret' } : null
    const storage = makeStorage({ load, credentials: legacyOnly })
    expect((await storage.active()).id).toBe('minio')
  })
})

describe('deleteMany', () => {
  /** Records what each backend was asked to delete. */
  function spyStorage(rows: BackendRow[]) {
    const seen = new Map<string, string[]>()
    const storage = makeStorage({
      load: async () => rows,
      credentials: creds,
      makeClient: (row) => ({
        bucket: row.bucket,
        deleteMany: async (keys: string[]) => {
          seen.set(row.id, [...(seen.get(row.id) ?? []), ...keys])
        },
      }),
    })
    return { storage, seen }
  }

  test('keys go to the backend that actually holds them', async () => {
    const { storage, seen } = spyStorage([MINIO, S3])
    await storage.deleteMany([
      { storage: 'minio', key: 'old/a.mp4' },
      { storage: 's3-jkt', key: 'new/b.mp4' },
      { storage: 'minio', key: 'old/c.jpg' },
    ])
    expect(seen.get('minio')).toEqual(['old/a.mp4', 'old/c.jpg'])
    expect(seen.get('s3-jkt')).toEqual(['new/b.mp4'])
  })

  test('one batched call per backend, not one per key', async () => {
    const { storage, seen } = spyStorage([MINIO])
    await storage.deleteMany([
      { storage: 'minio', key: 'a' },
      { storage: 'minio', key: 'b' },
    ])
    expect(seen.size).toBe(1)
  })

  test('nothing to delete touches no backend at all', async () => {
    const { storage, seen } = spyStorage([MINIO])
    await storage.deleteMany([])
    expect(seen.size).toBe(0)
  })

  test('a failing backend does not stop the others', async () => {
    const seen: string[] = []
    const storage = makeStorage({
      load: async () => [MINIO, S3],
      credentials: creds,
      makeClient: (row) => ({
        bucket: row.bucket,
        deleteMany: async (keys: string[]) => {
          if (row.id === 'minio') throw new Error('minio is down')
          seen.push(...keys)
        },
      }),
    })

    // Deleting a user's account must not abort halfway because one retired
    // backend is unreachable; the rest still has to go.
    await storage.deleteMany([
      { storage: 'minio', key: 'a' },
      { storage: 's3-jkt', key: 'b' },
    ])
    expect(seen).toEqual(['b'])
  })
})

describe('credential env names', () => {
  test('an id becomes a predictable pair of env vars', async () => {
    const { envNames } = await import('./storage.ts')
    expect(envNames('s3-jkt')).toEqual({
      accessKey: 'STORAGE_S3_JKT_ACCESS_KEY',
      secretKey: 'STORAGE_S3_JKT_SECRET_KEY',
    })
  })

  test('the derivation is uppercase with dashes as underscores', async () => {
    const { envNames } = await import('./storage.ts')
    expect(envNames('minio').accessKey).toBe('STORAGE_MINIO_ACCESS_KEY')
  })
})
