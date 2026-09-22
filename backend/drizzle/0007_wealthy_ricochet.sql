ALTER TABLE "videos" ADD COLUMN "proxy_key" text;--> statement-breakpoint
ALTER TABLE "videos" ADD COLUMN "strip_key" text;--> statement-breakpoint
ALTER TABLE "videos" ADD COLUMN "peaks" jsonb;--> statement-breakpoint
ALTER TABLE "videos" ADD COLUMN "asset_storage" text;--> statement-breakpoint
ALTER TABLE "videos" ADD COLUMN "proxy_bytes" integer;--> statement-breakpoint
ALTER TABLE "videos" ADD COLUMN "proxy_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "videos" ADD CONSTRAINT "videos_asset_storage_storage_backends_id_fk" FOREIGN KEY ("asset_storage") REFERENCES "public"."storage_backends"("id") ON DELETE no action ON UPDATE no action;