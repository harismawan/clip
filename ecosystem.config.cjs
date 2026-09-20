/**
 * pm2 apps for clip: the API and the worker.
 *
 * TWO PROCESSES, NOT ONE. The API never touches media -- it resolves URLs,
 * writes rows and streams progress -- while the worker shells out to yt-dlp,
 * whisper and ffmpeg. Deploying only the API produces a site that accepts jobs
 * and never finishes one, which looks like a hang rather than a missing
 * service. They are declared together so that cannot happen.
 *
 * Both read the single root .env, the same file `bun run dev:api` uses. There
 * is deliberately no backend/.env or worker/.env to drift from it.
 */
const { resolve } = require('node:path')

const ROOT = __dirname
const VENV_BIN = resolve(ROOT, 'worker/.venv/bin')
const BUN_BIN = resolve(process.env.HOME || '/root', '.bun/bin')

/**
 * pm2's daemon does not inherit the login shell's PATH, so anything the worker
 * shells out to has to be named here. whisper-ctranslate2 lives only in the
 * venv, and a missing one fails the job *after* the download completes.
 */
const workerPath = [VENV_BIN, BUN_BIN, process.env.PATH].filter(Boolean).join(':')
const apiPath = [BUN_BIN, process.env.PATH].filter(Boolean).join(':')

module.exports = {
  apps: [
    {
      name: 'clip-api',
      cwd: resolve(ROOT, 'backend'),
      script: 'bun',
      args: '--env-file=../.env src/index.ts',
      // Without this pm2 prepends node, which cannot run TypeScript.
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      max_memory_restart: '400M',
      env: { NODE_ENV: 'production', PATH: apiPath },
      time: true,
      merge_logs: true,
    },
    {
      name: 'clip-worker',
      cwd: resolve(ROOT, 'worker'),
      script: 'bun',
      args: '--env-file=../.env src/index.ts',
      interpreter: 'none',
      exec_mode: 'fork',
      // NEVER raise this. WORKER_CONCURRENCY is 1 because whisper and x264 each
      // want every core; a second pm2 instance would compete for the same queue
      // and make both slower, with the OOM killer as the tiebreak on 7GB.
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      // No max_memory_restart: MediaPipe's peak during reframe is legitimate,
      // and killing mid-render would lose the clip and leave scratch behind.
      env: { NODE_ENV: 'production', PATH: workerPath },
      // ffmpeg needs a moment to die; pm2's 1.6s default SIGKILLs mid-encode.
      kill_timeout: 10000,
      time: true,
      merge_logs: true,
    },
  ],
}
