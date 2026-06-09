import path from "node:path";
import { defineConfig } from "prisma/config";

// Config for the Postgres client/migrations. Used by:
//   prisma migrate deploy --config prisma.config.postgres.ts   (production)
//   prisma migrate diff/dev ...                                 (authoring)
// DATABASE_URL is supplied at run time (ECS migrate task, CI, local).
export default defineConfig({
  schema: path.join("prisma", "postgres", "schema.prisma"),
  migrations: {
    path: path.join("prisma", "postgres", "migrations"),
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "",
  },
});
