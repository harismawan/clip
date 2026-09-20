/**
 * Drizzle schema. Imported by both backend and worker (and, for its inferred
 * types, the frontend) so the wire contract has exactly one definition.
 *
 * Tier C added `users` and `sessions`. Ownership hangs off ONE column --
 * `jobs.user_id` -- because clips, renders and transcripts all reach a user
 * transitively through it, so there is a single place to get scoping right.
 *
 * `videos` and `transcripts` stay global on purpose: they are a URL-keyed cache
 * of the most expensive stage in the pipeline, and two users clipping the same
 * link should share it.
 */
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  doublePrecision,
  boolean,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core'

export const jobStatus = pgEnum('job_status', [
  'pending',
  'downloading',
  'transcribing',
  'analyzing',
  'rendering',
  'completed',
  'failed',
  'cancelled',
])

export const clipStatus = pgEnum('clip_status', ['pending', 'rendering', 'ready', 'failed'])
export const renderStatus = pgEnum('render_status', ['pending', 'rendering', 'ready', 'failed'])

/**
 * A signed-in person. Keyed on Google's `sub` claim rather than email: an
 * account's email address can change, and matching on email would hand the old
 * address's projects to whoever later inherits it. Email is display only.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    googleSub: text('google_sub').notNull().unique(),
    email: text('email').notNull(),
    name: text('name'),
    pictureUrl: text('picture_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('users_google_sub_idx').on(t.googleSub)],
)

/**
 * A live login. `id` is the SHA-256 of the cookie token, never the token itself,
 * so a database dump cannot be replayed as a session. The user index exists so
 * "log out everywhere" is one DELETE when it is wanted.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
)

/** A resolved source video. One row per URL; re-analysing the same URL reuses it. */
export const videos = pgTable(
  'videos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    url: text('url').notNull(),
    platform: text('platform').notNull(),
    title: text('title').notNull(),
    durationSeconds: integer('duration_seconds').notNull(),
    thumbnailUrl: text('thumbnail_url'),
    /** Uploader / channel, shown in the source card's meta line. */
    uploader: text('uploader'),
    /** Source publish date, ISO. Null when the extractor does not supply one. */
    publishedAt: text('published_at'),
    /** Best available height, e.g. 1080. Drives the "1080p available" meta text. */
    maxHeight: integer('max_height'),
    /** Absolute path to the downloaded file. Nulled once scratch is cleaned up. */
    scratchPath: text('scratch_path'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('videos_url_idx').on(t.url)],
)

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * The single owner column. Every ownership check in the API resolves to this
     * one, so a clip, render or download is reachable only through its job.
     */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    videoId: uuid('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    status: jobStatus('status').notNull().default('pending'),
    /** Human-readable sub-step, e.g. "Transcribing (12m of 48m)". */
    stage: text('stage'),
    progress: integer('progress').notNull().default(0),
    error: text('error'),

    // --- options captured from the setup screen ---
    clipCount: integer('clip_count').notNull(),
    /** 0 = <30s, 1 = 30-60s, 2 = 60-90s. Matches the frontend LENGTHS array. */
    lengthPreset: integer('length_preset').notNull(),
    /** e.g. {"9:16": true, "1:1": true, "4:5": false} */
    formats: jsonb('formats').$type<Record<string, boolean>>().notNull(),
    burnSubtitles: boolean('burn_subtitles').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('jobs_status_idx').on(t.status),
    index('jobs_created_idx').on(t.createdAt),
    // Both quota counts and every project listing filter on the owner.
    index('jobs_user_idx').on(t.userId),
  ],
)

/**
 * Keyed by video, not job, so a regenerate or a single-clip re-cut reuses the
 * transcript instead of paying 15-45 minutes of CPU for it twice.
 */
export const transcripts = pgTable(
  'transcripts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    videoId: uuid('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    language: text('language'),
    srtKey: text('srt_key'),
    segments: jsonb('segments').$type<TranscriptSegment[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('transcripts_video_idx').on(t.videoId)],
)

export const clips = pgTable(
  'clips',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    /** Ordinal within the job, for stable display order and file naming. */
    idx: integer('idx').notNull(),
    title: text('title').notNull(),
    startSeconds: doublePrecision('start_seconds').notNull(),
    endSeconds: doublePrecision('end_seconds').notNull(),
    /** Hook score 0-100, as returned by the model. */
    score: integer('score').notNull(),
    /** Transcript excerpt around the moment. */
    snippet: text('snippet').notNull(),
    /** Suggested social caption. */
    caption: text('caption').notNull(),
    /** Pre-wrapped two-line hook shown on the card (distinct from burned subs). */
    subtitleLine: text('subtitle_line').notNull(),
    status: clipStatus('status').notNull().default('pending'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('clips_job_idx').on(t.jobId)],
)

/**
 * One row per (clip, aspect ratio). Separate table because the setup screen
 * allows 9:16 AND 1:1 AND 4:5 simultaneously -- the prototype's flat Clip type
 * had nowhere to put three files.
 */
export const renders = pgTable(
  'renders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clipId: uuid('clip_id')
      .notNull()
      .references(() => clips.id, { onDelete: 'cascade' }),
    ratio: text('ratio').notNull(),
    s3Key: text('s3_key'),
    thumbKey: text('thumb_key'),
    width: integer('width'),
    height: integer('height'),
    sizeBytes: integer('size_bytes'),
    durationSeconds: doublePrecision('duration_seconds'),
    status: renderStatus('status').notNull().default('pending'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('renders_clip_idx').on(t.clipId)],
)

/** One whisper segment. Times are seconds from the start of the source. */
export interface TranscriptSegment {
  start: number
  end: number
  text: string
}

export type User = typeof users.$inferSelect
export type Session = typeof sessions.$inferSelect
export type Video = typeof videos.$inferSelect
export type Job = typeof jobs.$inferSelect
export type Transcript = typeof transcripts.$inferSelect
export type Clip = typeof clips.$inferSelect
export type Render = typeof renders.$inferSelect
