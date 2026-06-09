import { createSqliteClient, type SqliteDb } from "./prisma-sqlite.js";
import type {
  UrlStore,
  UrlEntry,
  NewUrlEntry,
  ConfigStore,
  AuditStore,
  AuditRecord,
  NewAuditRecord,
} from "./store.js";

type UrlConfigRow = {
  url: string;
  description: string;
  enabled: boolean;
  addedBy: string;
  addedAt: Date;
};

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

export class SqliteUrlStore implements UrlStore {
  constructor(private db: SqliteDb) {}

  async listEnabled(): Promise<UrlEntry[]> {
    await this.db.ready;
    const rows = await this.db.client.urlConfig.findMany({ where: { enabled: true } });
    return rows.map(toUrlEntry);
  }

  async listAll(): Promise<UrlEntry[]> {
    await this.db.ready;
    const rows = await this.db.client.urlConfig.findMany();
    return rows.map(toUrlEntry);
  }

  async upsert(entry: NewUrlEntry): Promise<void> {
    await this.db.ready;
    await this.db.client.urlConfig.upsert({
      where: { url: entry.url },
      create: {
        url: entry.url,
        description: entry.description,
        enabled: entry.enabled,
        addedBy: entry.added_by,
      },
      update: {
        description: entry.description,
        enabled: entry.enabled,
        addedBy: entry.added_by,
      },
    });
  }

  async delete(url: string): Promise<void> {
    await this.db.ready;
    await this.db.client.urlConfig.deleteMany({ where: { url } });
  }

  async count(): Promise<number> {
    await this.db.ready;
    return this.db.client.urlConfig.count();
  }
}

export class SqliteConfigStore implements ConfigStore {
  constructor(private db: SqliteDb) {}

  async get(key: string): Promise<string | undefined> {
    await this.db.ready;
    const row = await this.db.client.agentConfig.findUnique({ where: { key } });
    return row?.value;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db.ready;
    await this.db.client.agentConfig.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }
}

export class SqliteAuditStore implements AuditStore {
  constructor(private db: SqliteDb) {}

  async write(record: NewAuditRecord): Promise<void> {
    await this.db.ready;
    await this.db.client.auditLog.create({
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
    await this.db.ready;
    const rows = await this.db.client.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map(toAuditRecord);
  }

  async listByThread(channel: string, thread_ts: string): Promise<AuditRecord[]> {
    await this.db.ready;
    const rows = await this.db.client.auditLog.findMany({
      where: { channel, threadTs: thread_ts },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toAuditRecord);
  }
}

export function createSqliteStores(filePath: string): {
  urlStore: SqliteUrlStore;
  configStore: SqliteConfigStore;
  auditStore: SqliteAuditStore;
} {
  const db = createSqliteClient(filePath);
  return {
    urlStore: new SqliteUrlStore(db),
    configStore: new SqliteConfigStore(db),
    auditStore: new SqliteAuditStore(db),
  };
}

function toUrlEntry(row: UrlConfigRow): UrlEntry {
  return {
    url: row.url,
    description: row.description,
    enabled: row.enabled,
    added_by: row.addedBy,
    added_at: row.addedAt.toISOString(),
  };
}

function toAuditRecord(row: AuditLogRow): AuditRecord {
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
