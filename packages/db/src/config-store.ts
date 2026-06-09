import { createPostgresClient, type PostgresClient } from "./prisma-postgres.js";
import type { ConfigStore } from "./store.js";

export class PostgresConfigStore implements ConfigStore {
  private db: PostgresClient;

  constructor(connectionString: string) {
    this.db = createPostgresClient(connectionString);
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
