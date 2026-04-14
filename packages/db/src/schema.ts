import { pgTable, text, boolean, timestamp, serial, integer } from "drizzle-orm/pg-core";

export const slackUsers = pgTable("slack_users", {
  user_id: text("user_id").primaryKey(),
  real_name: text("real_name").notNull(),
  display_name: text("display_name").notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
