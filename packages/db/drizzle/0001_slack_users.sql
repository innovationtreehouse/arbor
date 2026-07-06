CREATE TABLE IF NOT EXISTS "slack_users" (
	"user_id" text PRIMARY KEY NOT NULL,
	"real_name" text NOT NULL,
	"display_name" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
