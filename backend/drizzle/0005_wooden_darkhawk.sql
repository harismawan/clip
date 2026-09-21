CREATE TABLE "storage_backends" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"endpoint" text,
	"region" text NOT NULL,
	"bucket" text NOT NULL,
	"path_style" boolean NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Seed the backend that already exists. MUST run before the ADD CONSTRAINT
-- statements below: adding the foreign key validates every existing renders and
-- transcripts row, all of which default to 'minio', so the referenced row has to
-- be there first or the migration fails on a non-empty table.
-- These values are the deployed S3_* settings and none of them are secret; the
-- access keys stay in the environment.
INSERT INTO "storage_backends"
  ("id", "label", "endpoint", "region", "bucket", "path_style", "is_active")
VALUES
  ('minio', 'Local MinIO', 'http://localhost:9020', 'us-east-1', 'clips', true, true);
ALTER TABLE "renders" ADD COLUMN "storage" text DEFAULT 'minio' NOT NULL;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "storage" text DEFAULT 'minio' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "storage_one_active" ON "storage_backends" USING btree ("is_active") WHERE "storage_backends"."is_active";--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "renders_storage_storage_backends_id_fk" FOREIGN KEY ("storage") REFERENCES "public"."storage_backends"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_storage_storage_backends_id_fk" FOREIGN KEY ("storage") REFERENCES "public"."storage_backends"("id") ON DELETE no action ON UPDATE no action;