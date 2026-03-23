import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const urlConfig = sqliteTable("url_config", {
  url: text("url").primaryKey(),
  description: text("description").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  added_by: text("added_by").notNull(),
  added_at: text("added_at").notNull().$default(() => new Date().toISOString()),
});

export const agentConfig = sqliteTable("agent_config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  channel: text("channel").notNull(),
  thread_ts: text("thread_ts").notNull(),
  user_id: text("user_id").notNull(),
  prompt: text("prompt").notNull(),
  response: text("response").notNull(),
  model: text("model"),
  duration_ms: integer("duration_ms").notNull(),
  created_at: text("created_at").notNull().$default(() => new Date().toISOString()),
});
