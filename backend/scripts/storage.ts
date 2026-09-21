/**
 * List and manage object-storage backends, from the box.
 *
 *   bun run storage                        every backend, what it holds
 *   bun run storage add <id> --bucket B --region R [--endpoint URL] [--path-style]
 *   bun run storage verify <id>            real round trip against the bucket
 *   bun run storage activate <id>          change where new uploads go
 *   bun run storage remove <id> --yes      delete a backend row
 *
 * Storage is a list, not an endpoint: one backend is the active write target and
 * every backend stays readable forever, so clips written before a move keep
 * playing from where they are. Nothing here ever migrates an object.
 *
 * Credentials are NOT stored here. They live in .env, one pair per id, so a
 * database dump cannot carry them -- the same reason sessions store a hash
 * rather than a token. `add` prints the exact two lines to paste.
 */
import { eq, sql } from 'drizzle-orm'
import { storageBackends, renders, transcripts } from '../../shared/schema.ts'
import { envNames } from '../../shared/storage.ts'
import { fmtBytes } from '../../shared/format.ts'

export type Command = 'list' | 'add' | 'verify' | 'activate' | 'remove'

export interface StorageArgs {
  command: Command
  id?: string
  label?: string
  bucket?: string
  region?: string
  endpoint?: string
  pathStyle: boolean
  confirmed: boolean
}

/** Ids derive env var names, so they are restricted to what survives that. */
const ID_RE = /^[a-z0-9-]+$/

export function parseArgs(argv: string[]): StorageArgs {
  const [raw, ...rest] = argv
  const command = (raw ?? 'list') as Command

  if (!['list', 'add', 'verify', 'activate', 'remove'].includes(command)) {
    throw new Error(`Unknown command "${command}". Try: list, add, verify, activate, remove`)
  }

  const args: StorageArgs = { command, pathStyle: false, confirmed: false }

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === '--path-style') args.pathStyle = true
    else if (arg === '--yes') args.confirmed = true
    else if (arg === '--bucket') args.bucket = need(rest[++i], '--bucket')
    else if (arg === '--region') args.region = need(rest[++i], '--region')
    else if (arg === '--endpoint') args.endpoint = need(rest[++i], '--endpoint')
    else if (arg === '--label') args.label = need(rest[++i], '--label')
    else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`)
    else if (args.id === undefined) args.id = arg
    else throw new Error(`Unexpected argument "${arg}" -- these commands act on one backend`)
  }

  if (command !== 'list' && !args.id) {
    throw new Error(`${command} needs a backend id, e.g. bun run storage ${command} s3-jkt`)
  }

  if (command === 'add') {
    if (!ID_RE.test(args.id!)) {
      throw new Error(
        `"${args.id}" cannot be a backend id. Use lowercase letters, digits and dashes: ` +
          `the id derives ${envNames('example').accessKey.replace('EXAMPLE', '<ID>')}, and anything ` +
          `else reads as "credentials missing" later.`,
      )
    }
    if (!args.bucket) throw new Error('add needs --bucket')
    if (!args.region) throw new Error('add needs --region')
  }

  return args
}

function need(value: string | undefined, flag: string): string {
  if (value === undefined || value.startsWith('-')) throw new Error(`${flag} needs a value`)
  return value
}

async function main() {
  const args = parseArgs(Bun.argv.slice(2))
  // Imported here, not at the top: env.ts exits the process when the
  // environment is unset, which would make parseArgs untestable.
  const { db } = await import('../src/db/index.ts')
  // The same lookup the resolver uses, not a copy: re-deriving it here is how
  // `list` ends up reporting MISSING for a backend that works perfectly well
  // through the legacy fallback.
  const { storage, credentials } = await import('../src/s3.ts')

  const rows = await db.select().from(storageBackends).orderBy(storageBackends.createdAt)
  const byId = new Map(rows.map((r) => [r.id, r]))

  const has = (id: string) => credentials(id) !== null

  /** Objects and bytes held, per backend. Two cheap grouped queries. */
  async function held() {
    const r = await db
      .select({
        storage: renders.storage,
        objects: sql<number>`count(*) filter (where ${renders.s3Key} is not null)
                           + count(*) filter (where ${renders.thumbKey} is not null)`,
        bytes: sql<number>`coalesce(sum(${renders.sizeBytes}), 0)`,
      })
      .from(renders)
      .groupBy(renders.storage)
    const t = await db
      .select({
        storage: transcripts.storage,
        objects: sql<number>`count(*) filter (where ${transcripts.srtKey} is not null)`,
      })
      .from(transcripts)
      .groupBy(transcripts.storage)

    const out = new Map<string, { objects: number; bytes: number }>()
    for (const row of r) out.set(row.storage, { objects: Number(row.objects), bytes: Number(row.bytes) })
    for (const row of t) {
      const cur = out.get(row.storage) ?? { objects: 0, bytes: 0 }
      cur.objects += Number(row.objects)
      out.set(row.storage, cur)
    }
    return out
  }

  if (args.command === 'list') {
    const usage = await held()
    console.log(`${rows.length} backend(s)\n`)
    for (const row of rows) {
      const u = usage.get(row.id) ?? { objects: 0, bytes: 0 }
      console.log(`${row.isActive ? '* ' : '  '}${row.id}  (${row.label})`)
      console.log(`    bucket       ${row.bucket} @ ${row.endpoint ?? `AWS ${row.region}`}`)
      console.log(`    holds        ${u.objects} object(s), ${fmtBytes(u.bytes)}`)
      // Never the value. Whether it is set is all anyone needs to see.
      console.log(`    credentials  ${has(row.id) ? 'present' : 'MISSING'}`)
    }
    console.log('\n* = active write target. New uploads go here.')
    return
  }

  const id = args.id!

  if (args.command === 'add') {
    if (byId.has(id)) {
      console.error(`Backend "${id}" already exists.`)
      process.exit(1)
    }
    // Inserted inactive on purpose: adding a storage must never silently
    // redirect production writes. Activating is a separate thing you type.
    await db.insert(storageBackends).values({
      id,
      label: args.label ?? id,
      endpoint: args.endpoint ?? null,
      region: args.region!,
      bucket: args.bucket!,
      pathStyle: args.pathStyle,
      isActive: false,
    })

    const names = envNames(id)
    console.log(`Added "${id}" (inactive). It holds nothing and receives nothing yet.\n`)
    console.log('1. Put these two lines in .env:\n')
    console.log(`     ${names.accessKey}=...`)
    console.log(`     ${names.secretKey}=...\n`)
    console.log('2. pm2 restart clip-api clip-worker     (credentials are read at startup)')
    console.log(`3. bun run storage verify ${id}`)
    console.log(`4. bun run storage activate ${id}`)
    return
  }

  if (!byId.has(id)) {
    console.error(`No backend "${id}". Run: bun run storage`)
    process.exit(1)
  }

  if (args.command === 'verify') {
    const ok = await verify(storage, id)
    process.exit(ok ? 0 : 1)
  }

  if (args.command === 'activate') {
    if (byId.get(id)!.isActive) {
      console.log(`"${id}" is already the active write target.`)
      return
    }
    // Verify first: activating a backend with wrong credentials breaks every
    // new job until somebody notices.
    if (!(await verify(storage, id))) {
      console.error('\nNot activating. Fix the above first.')
      process.exit(1)
    }

    // One transaction, so there is no instant with two actives or none -- the
    // partial unique index would reject the former anyway.
    await db.transaction(async (tx) => {
      await tx.update(storageBackends).set({ isActive: false }).where(eq(storageBackends.isActive, true))
      await tx.update(storageBackends).set({ isActive: true }).where(eq(storageBackends.id, id))
    })

    console.log(`\nActive write target is now "${id}".`)
    console.log('Both processes pick this up within 30s. No restart needed.')
    console.log('Existing clips keep serving from wherever they were written.')
    return
  }

  if (args.command === 'remove') {
    if (byId.get(id)!.isActive) {
      console.error(`"${id}" is the active write target. Activate another backend first.`)
      process.exit(1)
    }

    const u = (await held()).get(id) ?? { objects: 0, bytes: 0 }
    if (u.objects > 0) {
      // The foreign key would block this anyway; a counted sentence beats a
      // constraint violation.
      console.error(
        `"${id}" still holds ${u.objects} object(s) (${fmtBytes(u.bytes)}). ` +
          `A backend that owns objects cannot be removed -- those clips would ` +
          `become unreachable. Backends are read-only forever by design.`,
      )
      process.exit(1)
    }

    if (!args.confirmed) {
      console.log(`Would remove "${id}". It holds nothing, so nothing is lost.`)
      console.log('Re-run with --yes to do it.')
      return
    }

    await db.delete(storageBackends).where(eq(storageBackends.id, id))
    console.log(`Removed "${id}".`)
  }
}

/**
 * A real round trip: put, get, compare, delete.
 *
 * Each permission is reported separately because a bucket policy that allows
 * put but not delete looks perfectly healthy right up until deleting a project
 * starts silently orphaning objects.
 */
async function verify(storage: { get: (id: string) => Promise<any> }, id: string): Promise<boolean> {
  const key = `healthcheck/${crypto.randomUUID()}.txt`
  const body = Buffer.from(`clip storage check ${new Date().toISOString()}`, 'utf8')

  let s3: any
  try {
    s3 = await storage.get(id)
  } catch (e) {
    console.error(`  resolve  FAILED  ${(e as Error).message}`)
    return false
  }

  try {
    await s3.upload(key, body, 'text/plain')
    console.log('  put      ok')
  } catch (e) {
    console.error(`  put      FAILED  ${(e as Error).message}`)
    return false
  }

  try {
    const stream = await s3.getStream(key)
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    if (!Buffer.concat(chunks).equals(body)) {
      console.error('  get      FAILED  bytes came back different')
      return false
    }
    console.log('  get      ok')
  } catch (e) {
    console.error(`  get      FAILED  ${(e as Error).message}`)
    return false
  }

  try {
    await s3.deleteMany([key])
    console.log('  delete   ok')
  } catch (e) {
    console.error(`  delete   FAILED  ${(e as Error).message}`)
    console.error(`           (a test object is left at ${key})`)
    return false
  }

  return true
}

if (import.meta.main) {
  // A usage error is the expected way to get this wrong, and the messages here
  // explain what to type instead. Letting it escape as an unhandled rejection
  // buries that under a stack trace nobody needs.
  await main().catch((e: Error) => {
    console.error(e.message)
    process.exit(1)
  })
  process.exit(0)
}
