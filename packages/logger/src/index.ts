export type { AuditRecord, NewAuditRecord, AuditStore } from "@arbor/db";
export { PostgresAuditStore } from "@arbor/db";

import type { AuditStore, NewAuditRecord } from "@arbor/db";

export interface AuditLogger {
  log(record: NewAuditRecord): Promise<void>;
}

export function createAuditLogger(store: AuditStore): AuditLogger {
  return {
    async log(record: NewAuditRecord): Promise<void> {
      await store.write(record).catch((err) => {
        console.error("[audit] write failed:", err);
      });
    },
  };
}
