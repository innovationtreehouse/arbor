export interface UrlEntry {
  url: string;
  description: string;
  enabled: boolean;
  added_by: string;
  added_at: string; // ISO 8601
}

/** Fields required when inserting; added_at is set by the database. */
export type NewUrlEntry = Omit<UrlEntry, "added_at">;

export interface UrlStore {
  /** Returns only enabled entries — used by the URL Fetcher MCP server. */
  listEnabled(): Promise<UrlEntry[]>;
  /** Returns all entries regardless of enabled status — used by the admin command. */
  listAll(): Promise<UrlEntry[]>;
  /** Inserts or updates a URL entry. */
  upsert(entry: NewUrlEntry): Promise<void>;
  /** Removes a URL entry by primary key. */
  delete(url: string): Promise<void>;
  /** Returns the total count of entries (for enforcing MAX_URL_COUNT). */
  count(): Promise<number>;
}

export interface ConfigStore {
  /** Returns the value for a key, or undefined if not set. */
  get(key: string): Promise<string | undefined>;
  /** Sets a key to the given value (upsert). */
  set(key: string, value: string): Promise<void>;
}

export interface AuditRecord {
  id: number;
  channel: string;
  thread_ts: string;
  user_id: string;
  prompt: string;
  response: string;
  model: string | null;
  duration_ms: number;
  created_at: string; // ISO 8601
}

export type NewAuditRecord = Omit<AuditRecord, "id" | "created_at">;

export interface AuditStore {
  write(record: NewAuditRecord): Promise<void>;
  listRecent(limit: number): Promise<AuditRecord[]>;
  listByThread(channel: string, thread_ts: string): Promise<AuditRecord[]>;
}
