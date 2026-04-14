import { pgTable, text, boolean, timestamp, serial, integer } from "drizzle-orm/pg-core";

export const urlConfig = pgTable("url_config", {
  url: text("url").primaryKey(),
  description: text("description").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  added_by: text("added_by").notNull(),
  added_at: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentConfig = pgTable("agent_config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const auditLog = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  channel: text("channel").notNull(),
  thread_ts: text("thread_ts").notNull(),
  user_id: text("user_id").notNull(),
  prompt: text("prompt").notNull(),
  response: text("response").notNull(),
  model: text("model"),
  duration_ms: integer("duration_ms").notNull(),
  input_tokens: integer("input_tokens").notNull().default(0),
  output_tokens: integer("output_tokens").notNull().default(0),
  cache_read_tokens: integer("cache_read_tokens").notNull().default(0),
  cache_creation_tokens: integer("cache_creation_tokens").notNull().default(0),
  cost_usd: text("cost_usd").notNull().default("0"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
