ALTER TABLE "jobs" ADD COLUMN "attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "last_progress_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "jobs_status_progress" ON "jobs" USING btree ("status","last_progress_at");