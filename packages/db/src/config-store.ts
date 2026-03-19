import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { agentConfig } from "./schema.js";
import type { ConfigStore } from "./store.js";

export class PostgresConfigStore implements ConfigStore {
  private db: ReturnType<typeof drizzle>;

  constructor(connectionString: string) {
    const client = postgres(connectionString);
    this.db = drizzle(client, { schema: { agentConfig } });
  }

  async get(key: string): Promise<string | undefined> {
    const rows = await this.db
      .select()
      .from(agentConfig)
      .where(eq(agentConfig.key, key));
    return rows[0]?.value;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db
      .insert(agentConfig)
      .values({ key, value })
      .onConflictDoUpdate({
        target: agentConfig.key,
        set: { value },
      });
  }
}
