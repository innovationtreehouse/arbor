import { pgTable, text, boolean, timestamp } from "drizzle-orm/pg-core";

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
