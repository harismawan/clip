import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { env } from '../env.ts'
import * as schema from '../../../shared/schema.ts'
import { API_APP_NAME } from '../../../shared/queue.ts'

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  // Named so scripts/workers.sh can tell the API's connections from a worker's.
  application_name: API_APP_NAME,
  // The API does short reads and writes; the worker holds the long connections.
  max: 10,
})

export const db = drizzle(pool, { schema })

export * from '../../../shared/schema.ts'
