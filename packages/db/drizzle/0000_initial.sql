CREATE TABLE IF NOT EXISTS "agent_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "url_config" (
	"url" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"added_by" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
