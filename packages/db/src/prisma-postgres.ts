import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/postgres/index.js";

/** The generated Postgres Prisma client type, re-exported for the stores. */
export type PostgresClient = PrismaClient;

/**
 * Creates a Postgres-backed Prisma client. Prisma 7 has no embedded query
 * engine — connections go through the node-postgres driver adapter, which
 * accepts the connection string directly. The connection is lazy (opened on
 * first query), matching the previous postgres.js behaviour.
 */
export function createPostgresClient(connectionString: string): PostgresClient {
  const adapter = new PrismaPg(connectionString);
  return new PrismaClient({ adapter });
}
