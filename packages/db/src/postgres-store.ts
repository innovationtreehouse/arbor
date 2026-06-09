import { createPostgresClient, type PostgresClient } from "./prisma-postgres.js";
import type { UrlStore, UrlEntry, NewUrlEntry } from "./store.js";

type UrlConfigRow = {
  url: string;
  description: string;
  enabled: boolean;
  addedBy: string;
  addedAt: Date;
};

export class PostgresUrlStore implements UrlStore {
  private db: PostgresClient;

  constructor(connectionString: string) {
    this.db = createPostgresClient(connectionString);
  }

  async listEnabled(): Promise<UrlEntry[]> {
    const rows = await this.db.urlConfig.findMany({ where: { enabled: true } });
    return rows.map(toEntry);
  }

  async listAll(): Promise<UrlEntry[]> {
    const rows = await this.db.urlConfig.findMany();
    return rows.map(toEntry);
  }

  async upsert(entry: NewUrlEntry): Promise<void> {
    await this.db.urlConfig.upsert({
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
    await this.db.urlConfig.deleteMany({ where: { url } });
  }

  async count(): Promise<number> {
    return this.db.urlConfig.count();
  }
}

function toEntry(row: UrlConfigRow): UrlEntry {
  return {
    url: row.url,
    description: row.description,
    enabled: row.enabled,
    added_by: row.addedBy,
    added_at: row.addedAt.toISOString(),
  };
}
