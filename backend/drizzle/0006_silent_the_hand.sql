ALTER TABLE "clips" ADD COLUMN "proxy_key" text;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "proxy_bytes" integer;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "strip_key" text;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "peaks" jsonb;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "window_start" double precision;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "window_span" double precision;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "asset_storage" text DEFAULT 'minio' NOT NULL;--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_asset_storage_storage_backends_id_fk" FOREIGN KEY ("asset_storage") REFERENCES "public"."storage_backends"("id") ON DELETE no action ON UPDATE no action;