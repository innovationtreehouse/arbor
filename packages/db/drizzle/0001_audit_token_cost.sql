ALTER TABLE "audit_log" ADD COLUMN "input_tokens" integer NOT NULL DEFAULT 0;
ALTER TABLE "audit_log" ADD COLUMN "output_tokens" integer NOT NULL DEFAULT 0;
ALTER TABLE "audit_log" ADD COLUMN "cache_read_tokens" integer NOT NULL DEFAULT 0;
ALTER TABLE "audit_log" ADD COLUMN "cache_creation_tokens" integer NOT NULL DEFAULT 0;
ALTER TABLE "audit_log" ADD COLUMN "cost_usd" text NOT NULL DEFAULT '0';
