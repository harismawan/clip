CREATE TABLE "video_source_cache" (
	"video_id" uuid NOT NULL,
	"host_id" text NOT NULL,
	"path" text NOT NULL,
	"bytes" bigint NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"refs" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "video_source_cache_video_id_host_id_pk" PRIMARY KEY("video_id","host_id")
);
--> statement-breakpoint
ALTER TABLE "video_source_cache" ADD CONSTRAINT "video_source_cache_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "video_source_cache_host_used_idx" ON "video_source_cache" USING btree ("host_id","used_at");--> statement-breakpoint
ALTER TABLE "videos" DROP COLUMN "scratch_path";