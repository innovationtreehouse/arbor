CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"thread_ts" text NOT NULL,
	"user_id" text NOT NULL,
	"prompt" text NOT NULL,
	"response" text NOT NULL,
	"model" text,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
