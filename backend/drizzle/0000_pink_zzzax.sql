CREATE TYPE "public"."clip_status" AS ENUM('pending', 'rendering', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'downloading', 'transcribing', 'analyzing', 'rendering', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."render_status" AS ENUM('pending', 'rendering', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "clips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"title" text NOT NULL,
	"start_seconds" double precision NOT NULL,
	"end_seconds" double precision NOT NULL,
	"score" integer NOT NULL,
	"snippet" text NOT NULL,
	"caption" text NOT NULL,
	"subtitle_line" text NOT NULL,
	"status" "clip_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"video_id" uuid NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"stage" text,
	"progress" integer DEFAULT 0 NOT NULL,
	"error" text,
	"clip_count" integer NOT NULL,
	"length_preset" integer NOT NULL,
	"formats" jsonb NOT NULL,
	"burn_subtitles" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "renders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clip_id" uuid NOT NULL,
	"ratio" text NOT NULL,
	"s3_key" text,
	"thumb_key" text,
	"width" integer,
	"height" integer,
	"size_bytes" integer,
	"duration_seconds" double precision,
	"status" "render_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"video_id" uuid NOT NULL,
	"language" text,
	"srt_key" text,
	"segments" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "videos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"platform" text NOT NULL,
	"title" text NOT NULL,
	"duration_seconds" integer NOT NULL,
	"thumbnail_url" text,
	"uploader" text,
	"published_at" text,
	"max_height" integer,
	"scratch_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "renders_clip_id_clips_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."clips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clips_job_idx" ON "clips" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "jobs_created_idx" ON "jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "renders_clip_idx" ON "renders" USING btree ("clip_id");--> statement-breakpoint
CREATE INDEX "transcripts_video_idx" ON "transcripts" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "videos_url_idx" ON "videos" USING btree ("url");