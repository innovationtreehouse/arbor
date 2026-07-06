-- IF NOT EXISTS: dev/prod already have these tables from the drizzle era with no
-- _prisma_migrations baseline; this lets the first `migrate deploy` self-baseline
-- (no-op apply + record) instead of failing P3018 and bricking the pipeline.
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE IF NOT EXISTS "url_config" (
    "url" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "added_by" TEXT NOT NULL,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "url_config_pkey" PRIMARY KEY ("url")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "agent_config" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "agent_config_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "audit_log" (
    "id" SERIAL NOT NULL,
    "channel" TEXT NOT NULL,
    "thread_ts" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "model" TEXT,
    "duration_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

