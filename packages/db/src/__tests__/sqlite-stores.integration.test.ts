/**
 * Integration test for the SQLite store implementations.
 *
 * Verifies that SqliteUrlStore, SqliteConfigStore, and SqliteAuditStore
 * satisfy the same contracts as their Postgres counterparts — using a
 * real SQLite file on disk so we exercise file I/O, schema creation, and
 * persistence across multiple createStores() calls (simulating a process
 * restart).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStores } from "../create-stores.js";

let dbPath: string;

beforeAll(() => {
  dbPath = path.join(os.tmpdir(), `arbor-sqlite-integration-${process.pid}.db`);
});

afterAll(() => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

describe("SQLite stores — file-backed integration", () => {
  // ---------------------------------------------------------------------------
  // Schema auto-creation
  // ---------------------------------------------------------------------------

  it("creates all tables on first open without a migration step", () => {
    expect(fs.existsSync(dbPath)).toBe(false);
    const { urlStore } = createStores(dbPath);
    // If tables were not created the next call would throw
    expect(urlStore.listAll()).resolves.toEqual([]);
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Persistence across connections
  // ---------------------------------------------------------------------------

  it("data written in one createStores call is readable in a subsequent call", async () => {
    const s1 = createStores(dbPath);
    await s1.urlStore.upsert({
      url: "https://persist-test.example.com",
      description: "Persistence check",
      added_by: "U_TEST",
      enabled: true,
    });
    await s1.configStore.set("model", "claude-opus-4-6");
    await s1.auditStore.write({
      channel: "C1",
      thread_ts: "1.0",
      user_id: "U_TEST",
      prompt: "hello",
      response: "world",
      model: "claude-opus-4-6",
      duration_ms: 100,
    });

    // Open a fresh connection (simulates process restart)
    const s2 = createStores(dbPath);
    const urls = await s2.urlStore.listAll();
    expect(urls).toHaveLength(1);
    expect(urls[0].url).toBe("https://persist-test.example.com");

    const model = await s2.configStore.get("model");
    expect(model).toBe("claude-opus-4-6");

    const audits = await s2.auditStore.listRecent(10);
    expect(audits).toHaveLength(1);
    expect(audits[0].prompt).toBe("hello");
  });

  // ---------------------------------------------------------------------------
  // UrlStore contract
  // ---------------------------------------------------------------------------

  describe("UrlStore", () => {
    it("listEnabled excludes disabled entries", async () => {
      const { urlStore } = createStores(dbPath);
      await urlStore.upsert({ url: "https://enabled.example.com", description: "On", added_by: "U1", enabled: true });
      await urlStore.upsert({ url: "https://disabled.example.com", description: "Off", added_by: "U1", enabled: false });

      const enabled = await urlStore.listEnabled();
      const urls = enabled.map((e) => e.url);
      expect(urls).toContain("https://enabled.example.com");
      expect(urls).not.toContain("https://disabled.example.com");
    });

    it("count reflects only stored entries", async () => {
      const { urlStore } = createStores(dbPath);
      const before = await urlStore.count();
      await urlStore.upsert({ url: "https://count-test.example.com", description: "Count", added_by: "U1", enabled: true });
      expect(await urlStore.count()).toBe(before + 1);
    });

    it("delete removes the entry and count decreases", async () => {
      const { urlStore } = createStores(dbPath);
      await urlStore.upsert({ url: "https://delete-me.example.com", description: "Del", added_by: "U1", enabled: true });
      const before = await urlStore.count();
      await urlStore.delete("https://delete-me.example.com");
      expect(await urlStore.count()).toBe(before - 1);
    });

    it("upsert is idempotent — second call updates, does not duplicate", async () => {
      const { urlStore } = createStores(dbPath);
      const url = "https://upsert-test.example.com";
      await urlStore.upsert({ url, description: "v1", added_by: "U1", enabled: true });
      await urlStore.upsert({ url, description: "v2", added_by: "U2", enabled: false });
      const all = await urlStore.listAll();
      const entry = all.find((e) => e.url === url)!;
      expect(entry.description).toBe("v2");
      expect(entry.enabled).toBe(false);
      expect(all.filter((e) => e.url === url)).toHaveLength(1);
    });

    it("added_at is an ISO 8601 string", async () => {
      const { urlStore } = createStores(dbPath);
      await urlStore.upsert({ url: "https://ts-test.example.com", description: "TS", added_by: "U1", enabled: true });
      const entry = (await urlStore.listAll()).find((e) => e.url === "https://ts-test.example.com")!;
      expect(() => new Date(entry.added_at).toISOString()).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // ConfigStore contract
  // ---------------------------------------------------------------------------

  describe("ConfigStore", () => {
    it("get returns undefined for a key that was never set", async () => {
      const { configStore } = createStores(dbPath);
      expect(await configStore.get("nonexistent-key")).toBeUndefined();
    });

    it("set overwrites the previous value for the same key", async () => {
      const { configStore } = createStores(dbPath);
      await configStore.set("theme", "dark");
      await configStore.set("theme", "light");
      expect(await configStore.get("theme")).toBe("light");
    });
  });

  // ---------------------------------------------------------------------------
  // AuditStore contract
  // ---------------------------------------------------------------------------

  describe("AuditStore", () => {
    it("listRecent returns entries in descending created_at order", async () => {
      const { auditStore } = createStores(dbPath);
      await auditStore.write({ channel: "C_ORDER", thread_ts: "1.0", user_id: "U1", prompt: "first", response: "r1", model: null, duration_ms: 10 });
      await auditStore.write({ channel: "C_ORDER", thread_ts: "1.0", user_id: "U1", prompt: "second", response: "r2", model: null, duration_ms: 20 });

      const rows = await auditStore.listRecent(10);
      const order = rows.filter((r) => r.channel === "C_ORDER").map((r) => r.prompt);
      expect(order.indexOf("second")).toBeLessThan(order.indexOf("first"));
    });

    it("listByThread only returns records matching both channel and thread_ts", async () => {
      const { auditStore } = createStores(dbPath);
      await auditStore.write({ channel: "C_A", thread_ts: "T1", user_id: "U1", prompt: "match", response: "r", model: null, duration_ms: 1 });
      await auditStore.write({ channel: "C_A", thread_ts: "T2", user_id: "U1", prompt: "no-match-ts", response: "r", model: null, duration_ms: 1 });
      await auditStore.write({ channel: "C_B", thread_ts: "T1", user_id: "U1", prompt: "no-match-chan", response: "r", model: null, duration_ms: 1 });

      const rows = await auditStore.listByThread("C_A", "T1");
      expect(rows.every((r) => r.channel === "C_A" && r.thread_ts === "T1")).toBe(true);
      expect(rows.some((r) => r.prompt === "match")).toBe(true);
      expect(rows.some((r) => r.prompt === "no-match-ts")).toBe(false);
      expect(rows.some((r) => r.prompt === "no-match-chan")).toBe(false);
    });

    it("write with null model stores and retrieves null", async () => {
      const { auditStore } = createStores(dbPath);
      await auditStore.write({ channel: "C_NULL", thread_ts: "1.0", user_id: "U1", prompt: "p", response: "r", model: null, duration_ms: 50 });
      const rows = await auditStore.listByThread("C_NULL", "1.0");
      expect(rows[0].model).toBeNull();
    });

    it("id is a positive integer auto-assigned by the database", async () => {
      const { auditStore } = createStores(dbPath);
      await auditStore.write({ channel: "C_ID", thread_ts: "1.0", user_id: "U1", prompt: "p", response: "r", model: null, duration_ms: 1 });
      const rows = await auditStore.listByThread("C_ID", "1.0");
      expect(typeof rows[0].id).toBe("number");
      expect(rows[0].id).toBeGreaterThan(0);
    });
  });
});
