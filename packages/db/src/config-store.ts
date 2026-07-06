import { createPostgresClient, type PostgresClient } from "./prisma-postgres.js";
import type { ConfigStore } from "./store.js";

export class PostgresConfigStore implements ConfigStore {
  private db: PostgresClient;

  // Pass a shared PostgresClient when constructing several stores in one
  // process — each client owns its own pg connection pool.
  constructor(db: string | PostgresClient) {
    this.db = typeof db === "string" ? createPostgresClient(db) : db;
  }

  async get(key: string): Promise<string | undefined> {
    const row = await this.db.agentConfig.findUnique({ where: { key } });
    return row?.value;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db.agentConfig.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }
}
