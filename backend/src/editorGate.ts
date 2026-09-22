/**
 * The editor's off switch, on the server side.
 *
 * Hiding the Edit chip stops the button, not the feature: the routes behind it
 * are ordinary HTTP and a bookmark, an old tab or a curl reaches them just the
 * same. So the flag is enforced here as well, and this is the half that makes
 * "nobody can access it" true rather than merely "nobody can see it".
 *
 * 404, NOT 403. While the editor is switched off these endpoints do not exist
 * as far as the outside world is concerned; 403 would advertise a feature that
 * is deliberately unavailable and invite retrying. It also matches what these
 * same routes already answer for a job or clip the caller does not own.
 *
 * Applied ONLY to routes the editor alone uses. `POST /clips/:id/redo` is not
 * one of them -- the results screen's per-clip Redo button calls it, and that
 * button is staying.
 */
import type { MiddlewareHandler } from 'hono'
import { env } from './env.ts'

export const editorGate: MiddlewareHandler = async (c, next) => {
  if (!env.EDITOR_ENABLED) return c.json({ error: 'Not found' }, 404)
  await next()
}
