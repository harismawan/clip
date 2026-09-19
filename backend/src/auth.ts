import { timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { env } from './env.ts'

const expected = Buffer.from(env.API_TOKEN)

/**
 * Shared-secret gate.
 *
 * This exists because POST /api/jobs is otherwise an unauthenticated
 * "download an arbitrary URL and burn every core for 40 minutes" endpoint.
 * Exposed at clip2.mhamzah.id that hands a stranger free compute, bandwidth and
 * storage, and lets them wedge the box.
 *
 * It is a gate, not identity: everyone holding the token shares one pool of
 * projects. Per-user isolation is Tier C.
 */
export const requireToken: MiddlewareHandler = async (c, next) => {
  const header = c.req.header('Authorization') ?? ''
  let token = header.startsWith('Bearer ') ? header.slice(7) : ''

  // EventSource cannot set request headers, so the SSE route -- and only that
  // route -- also accepts the token as a query parameter. Allowing it
  // everywhere would leak the secret into access logs and Referer headers.
  if (!token && c.req.path.endsWith('/events')) {
    token = c.req.query('token') ?? ''
  }

  if (!safeEqual(token, expected)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  await next()
}

/**
 * timingSafeEqual throws on a length mismatch, which would itself leak length
 * through the error path -- so compare lengths first and always run the
 * comparison against a same-length buffer.
 */
function safeEqual(given: string, want: Buffer): boolean {
  const g = Buffer.from(given)
  if (g.length !== want.length) {
    // Still burn a comparison so the failure time does not depend on length.
    timingSafeEqual(want, want)
    return false
  }
  return timingSafeEqual(g, want)
}
