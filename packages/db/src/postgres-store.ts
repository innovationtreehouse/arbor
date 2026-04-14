import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, count } from "drizzle-orm";
import { urlConfig, slackUsers } from "./schema.js";
import type { UrlStore, UrlEntry, NewUrlEntry, UserStore, SlackUser } from "./store.js";

export class PostgresUrlStore implements UrlStore {
  private db: ReturnType<typeof drizzle>;

  constructor(connectionString: string) {
    const client = postgres(connectionString);
    this.db = drizzle(client, { schema: { urlConfig } });
  }

  async listEnabled(): Promise<UrlEntry[]> {
    const rows = await this.db
      .select()
      .from(urlConfig)
      .where(eq(urlConfig.enabled, true));
    return rows.map(toEntry);
  }

  async listAll(): Promise<UrlEntry[]> {
    const rows = await this.db.select().from(urlConfig);
    return rows.map(toEntry);
  }

  async upsert(entry: NewUrlEntry): Promise<void> {
    await this.db
      .insert(urlConfig)
      .values({
        url: entry.url,
        description: entry.description,
        enabled: entry.enabled,
        added_by: entry.added_by,
      })
      .onConflictDoUpdate({
        target: urlConfig.url,
        set: {
          description: entry.description,
          enabled: entry.enabled,
          added_by: entry.added_by,
        },
      });
  }

  async delete(url: string): Promise<void> {
    await this.db.delete(urlConfig).where(eq(urlConfig.url, url));
  }

  async count(): Promise<number> {
    const result = await this.db
      .select({ value: count() })
      .from(urlConfig);
    return Number(result[0]?.value ?? 0);
  }
}

/* v8 ignore start */
export class PostgresUserStore implements UserStore {
  private db: ReturnType<typeof drizzle>;

  constructor(connectionString: string) {
    const client = postgres(connectionString);
    this.db = drizzle(client, { schema: { slackUsers } });
  }

  async upsert(user: Omit<SlackUser, "updated_at">): Promise<void> {
    await this.db
      .insert(slackUsers)
      .values({ user_id: user.user_id, real_name: user.real_name, display_name: user.display_name })
      .onConflictDoUpdate({
        target: slackUsers.user_id,
        set: { real_name: user.real_name, display_name: user.display_name, updated_at: new Date() },
      });
  }

  async get(user_id: string): Promise<SlackUser | undefined> {
    const row = await this.db.select().from(slackUsers).where(eq(slackUsers.user_id, user_id)).limit(1);
    return row[0] ? toSlackUser(row[0]) : undefined;
  }
}
/* v8 ignore stop */

function toSlackUser(row: typeof slackUsers.$inferSelect): SlackUser {
  return {
    user_id: row.user_id,
    real_name: row.real_name,
    display_name: row.display_name,
    updated_at: row.updated_at.toISOString(),
  };
}

function toEntry(row: typeof urlConfig.$inferSelect): UrlEntry {
  return {
    url: row.url,
    description: row.description,
    enabled: row.enabled,
    added_by: row.added_by,
    added_at: row.added_at.toISOString(),
  };
}
