import path from "node:path";
import { defineConfig } from "prisma/config";

// Config for the SQLite client used in local dev and tests. SQLite schema is
// bootstrapped at runtime by the store layer (see src/sqlite-stores.ts), so
// migrations are not deployed for SQLite — this config exists for `prisma
// generate` and schema-authoring commands.
export default defineConfig({
  schema: path.join("prisma", "sqlite", "schema.prisma"),
  datasource: {
    url: process.env.DATABASE_URL ?? "file:./dev.db",
  },
});
