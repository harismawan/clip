import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    /**
     * Proxy /api so development runs on ONE origin, exactly as production does
     * behind nginx.
     *
     * This is not a convenience. The session cookie is SameSite=Lax, which a
     * browser will not send on a cross-origin fetch from :5173 to :3014 -- so
     * without this, signing in locally appears to work and then every API call
     * comes back 401. The alternative, SameSite=None, would weaken the cookie in
     * production to fix a development-only problem.
     *
     * The OAuth callback redirects to '/', which lands here rather than on the
     * API, so the login round trip also works end to end in dev.
     */
    // 3014 is PORT in the root .env, the same number deploy.sh checks the vhost
    // against.
    proxy: { '/api': 'http://127.0.0.1:3014' },
  },
})
