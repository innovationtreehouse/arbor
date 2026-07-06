import { createPostgresClient, type PostgresClient } from "./prisma-postgres.js";
import type { AuditStore, AuditRecord, NewAuditRecord } from "./store.js";

type AuditLogRow = {
  id: number;
  channel: string;
  threadTs: string;
  userId: string;
  prompt: string;
  response: string;
  model: string | null;
  durationMs: number;
  createdAt: Date;
};

/* v8 ignore start */
export class PostgresAuditStore implements AuditStore {
  private db: PostgresClient;

  // Pass a shared PostgresClient when constructing several stores in one
  // process — each client owns its own pg connection pool.
  constructor(db: string | PostgresClient) {
    this.db = typeof db === "string" ? createPostgresClient(db) : db;
  }

  async write(record: NewAuditRecord): Promise<void> {
    await this.db.auditLog.create({
      data: {
        channel: record.channel,
        threadTs: record.thread_ts,
        userId: record.user_id,
        prompt: record.prompt,
        response: record.response,
        model: record.model ?? null,
        durationMs: record.duration_ms,
      },
    });
  }

  async listRecent(limit: number): Promise<AuditRecord[]> {
    const rows = await this.db.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map(toRecord);
  }

  async listByThread(channel: string, thread_ts: string): Promise<AuditRecord[]> {
    const rows = await this.db.auditLog.findMany({
      where: { channel, threadTs: thread_ts },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toRecord);
  }
}

function toRecord(row: AuditLogRow): AuditRecord {
  return {
    id: row.id,
    channel: row.channel,
    thread_ts: row.threadTs,
    user_id: row.userId,
    prompt: row.prompt,
    response: row.response,
    model: row.model,
    duration_ms: row.durationMs,
    created_at: row.createdAt.toISOString(),
  };
}
/* v8 ignore stop */
