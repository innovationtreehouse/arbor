import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/sqlite/index.js";

/**
 * DDL that mirrors prisma/sqlite/schema.prisma (verified against the output of
 * `prisma db push`). The SQLite path is used for local dev and tests where the
 * database is created on demand, so — unlike Postgres — there is no migration
 * step. We bootstrap the schema on first connection instead. IF NOT EXISTS
 * keeps it idempotent across reconnects to the same file.
 */
const BOOTSTRAP_DDL = [
  `CREATE TABLE IF NOT EXISTS "url_config" (
    "url" TEXT NOT NULL PRIMARY KEY,
    "description" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "added_by" TEXT NOT NULL,
    "added_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS "agent_config" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "audit_log" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "channel" TEXT NOT NULL,
    "thread_ts" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "model" TEXT,
    "duration_ms" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
];

/**
 * A SQLite Prisma client paired with the promise that creates its schema.
 * The driver adapter keeps a single better-sqlite3 connection, so the DDL run
 * via $executeRawUnsafe applies to the same connection the client queries —
 * this is what makes :memory: databases work. Every store method awaits
 * `ready` before its first query.
 */
export interface SqliteDb {
  client: PrismaClient;
  ready: Promise<void>;
}

/**
 * Opens a SQLite database. `url` is a better-sqlite3 filename or ":memory:".
 * timestampFormat: "iso8601" stores DateTime columns as ISO-8601 text, so the
 * added_at / created_at values round-trip as ISO strings (the store contract).
 */
export function createSqliteClient(url: string): SqliteDb {
  const adapter = new PrismaBetterSqlite3({ url }, { timestampFormat: "iso8601" });
  const client = new PrismaClient({ adapter });
  const ready = (async () => {
    for (const stmt of BOOTSTRAP_DDL) {
      await client.$executeRawUnsafe(stmt);
    }
  })();
  return { client, ready };
}
