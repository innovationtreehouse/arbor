/**
 * Deployment-environment integration test for the SQLite adapter.
 *
 * Simulates the exact flows that run in production when the agent is deployed
 * with a local SQLite database (DATABASE_URL=file:/data/squirrel.db):
 *
 *  1. Lambda slash-command handler adds/removes monitored URLs
 *  2. Agent reads enabled URLs before each run
 *  3. Agent writes an audit record after responding
 *  4. Admin queries audit history by thread and recency
 *
 * Uses a file: URI (not :memory:) so createStores() exercises the same
 * code path as the deployed container.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStores } from "../create-stores.js";

let dbUri: string;
let dbPath: string;

beforeAll(() => {
  dbPath = path.join(os.tmpdir(), `arbor-sqlite-deploy-${process.pid}.db`);
  dbUri = `file:${dbPath}`;
});

afterAll(() => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

describe.skipIf(process.env.DATABASE_URL?.startsWith("postgres"))("SQLite adapter — deployment environment simulation", () => {
  // ---------------------------------------------------------------------------
  // Scenario 1: Lambda /add-url and /remove-url flows
  // ---------------------------------------------------------------------------

  describe("Lambda URL management flow", () => {
    it("accepts a file: URI and creates the database automatically", async () => {
      expect(fs.existsSync(dbPath)).toBe(false);
      const { urlStore } = createStores(dbUri);
      // listAll() would throw if schema wasn't created
      await expect(urlStore.listAll()).resolves.toEqual([]);
      expect(fs.existsSync(dbPath)).toBe(true);
    });

    it("lambda adds a URL and the agent can see it as enabled", async () => {
      // Lambda: /add-url
      const lambda = createStores(dbUri);
      await lambda.urlStore.upsert({
        url: "https://docs.example.com",
        description: "Product docs",
        added_by: "U_ADMIN",
        enabled: true,
      });

      // Agent: reads enabled URLs before a run
      const agent = createStores(dbUri);
      const enabled = await agent.urlStore.listEnabled();
      expect(enabled.map((e) => e.url)).toContain("https://docs.example.com");
    });

    it("lambda disables a URL and the agent no longer sees it", async () => {
      const lambda = createStores(dbUri);
      await lambda.urlStore.upsert({
        url: "https://docs.example.com",
        description: "Product docs",
        added_by: "U_ADMIN",
        enabled: false,
      });

      const agent = createStores(dbUri);
      const enabled = await agent.urlStore.listEnabled();
      expect(enabled.map((e) => e.url)).not.toContain("https://docs.example.com");
    });

    it("lambda deletes a URL and count reflects removal", async () => {
      const lambda = createStores(dbUri);
      await lambda.urlStore.upsert({
        url: "https://to-delete.example.com",
        description: "Temp",
        added_by: "U_ADMIN",
        enabled: true,
      });
      const before = await lambda.urlStore.count();

      await lambda.urlStore.delete("https://to-delete.example.com");
      expect(await lambda.urlStore.count()).toBe(before - 1);
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 2: Agent configuration flow
  // ---------------------------------------------------------------------------

  describe("Agent configuration flow", () => {
    it("lambda sets model config and agent reads it back", async () => {
      const lambda = createStores(dbUri);
      await lambda.configStore.set("model", "claude-opus-4-6");

      const agent = createStores(dbUri);
      expect(await agent.configStore.get("model")).toBe("claude-opus-4-6");
    });

    it("missing config key returns undefined (agent falls back to default)", async () => {
      const { configStore } = createStores(dbUri);
      expect(await configStore.get("unset-key")).toBeUndefined();
    });

    it("lambda updates model and agent sees latest value", async () => {
      const lambda = createStores(dbUri);
      await lambda.configStore.set("model", "claude-sonnet-4-6");

      const agent = createStores(dbUri);
      expect(await agent.configStore.get("model")).toBe("claude-sonnet-4-6");
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 3: Agent audit logging flow
  // ---------------------------------------------------------------------------

  describe("Agent audit logging flow", () => {
    it("agent writes audit record after responding", async () => {
      const agent = createStores(dbUri);
      await agent.auditStore.write({
        channel: "C_GENERAL",
        thread_ts: "1700000000.000001",
        user_id: "U_BOB",
        prompt: "What is the capital of France?",
        response: "Paris.",
        model: "claude-sonnet-4-6",
        duration_ms: 342,
      });

      const admin = createStores(dbUri);
      const recent = await admin.auditStore.listRecent(5);
      const record = recent.find((r) => r.prompt === "What is the capital of France?");
      expect(record).toBeDefined();
      expect(record!.response).toBe("Paris.");
      expect(record!.duration_ms).toBe(342);
      expect(record!.model).toBe("claude-sonnet-4-6");
    });

    it("audit record id is a positive integer assigned by the database", async () => {
      const { auditStore } = createStores(dbUri);
      await auditStore.write({
        channel: "C_ID_CHECK",
        thread_ts: "1.0",
        user_id: "U1",
        prompt: "p",
        response: "r",
        model: null,
        duration_ms: 1,
      });
      const rows = await auditStore.listByThread("C_ID_CHECK", "1.0");
      expect(typeof rows[0].id).toBe("number");
      expect(rows[0].id).toBeGreaterThan(0);
    });

    it("audit record created_at is an ISO 8601 timestamp", async () => {
      const { auditStore } = createStores(dbUri);
      await auditStore.write({
        channel: "C_TS",
        thread_ts: "2.0",
        user_id: "U1",
        prompt: "time?",
        response: "now",
        model: null,
        duration_ms: 5,
      });
      const rows = await auditStore.listByThread("C_TS", "2.0");
      expect(() => new Date(rows[0].created_at).toISOString()).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 4: Admin audit query flow
  // ---------------------------------------------------------------------------

  describe("Admin audit query flow", () => {
    it("admin queries thread history and sees only that thread", async () => {
      const agent = createStores(dbUri);
      await agent.auditStore.write({
        channel: "C_THREAD",
        thread_ts: "T_ALICE",
        user_id: "U_ALICE",
        prompt: "Hello",
        response: "Hi there",
        model: "claude-sonnet-4-6",
        duration_ms: 100,
      });
      await agent.auditStore.write({
        channel: "C_THREAD",
        thread_ts: "T_BOB",
        user_id: "U_BOB",
        prompt: "Hey",
        response: "Hello",
        model: "claude-sonnet-4-6",
        duration_ms: 80,
      });

      const admin = createStores(dbUri);
      const thread = await admin.auditStore.listByThread("C_THREAD", "T_ALICE");
      expect(thread.every((r) => r.thread_ts === "T_ALICE")).toBe(true);
      expect(thread.some((r) => r.prompt === "Hello")).toBe(true);
      expect(thread.some((r) => r.prompt === "Hey")).toBe(false);
    });

    it("listRecent returns records in descending order (newest first)", async () => {
      const agent = createStores(dbUri);
      await agent.auditStore.write({
        channel: "C_ORDER",
        thread_ts: "T_ORDER",
        user_id: "U1",
        prompt: "first",
        response: "r1",
        model: null,
        duration_ms: 10,
      });
      await agent.auditStore.write({
        channel: "C_ORDER",
        thread_ts: "T_ORDER",
        user_id: "U1",
        prompt: "second",
        response: "r2",
        model: null,
        duration_ms: 20,
      });

      const admin = createStores(dbUri);
      const rows = await admin.auditStore.listRecent(50);
      const orderRows = rows.filter((r) => r.channel === "C_ORDER");
      expect(orderRows.indexOf(orderRows.find((r) => r.prompt === "second")!))
        .toBeLessThan(orderRows.indexOf(orderRows.find((r) => r.prompt === "first")!));
    });

    it("null model is stored and retrieved correctly", async () => {
      const agent = createStores(dbUri);
      await agent.auditStore.write({
        channel: "C_NULL_MODEL",
        thread_ts: "T1",
        user_id: "U1",
        prompt: "p",
        response: "r",
        model: null,
        duration_ms: 1,
      });

      const admin = createStores(dbUri);
      const rows = await admin.auditStore.listByThread("C_NULL_MODEL", "T1");
      expect(rows[0].model).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 5: Full end-to-end session
  // ---------------------------------------------------------------------------

  describe("Full session: add URL → agent runs → admin reviews", () => {
    it("simulates a complete interaction cycle", async () => {
      // Step 1: Lambda admin adds a URL
      const lambdaStores = createStores(dbUri);
      await lambdaStores.urlStore.upsert({
        url: "https://api.example.com/docs",
        description: "API reference",
        added_by: "U_ADMIN",
        enabled: true,
      });
      await lambdaStores.configStore.set("model", "claude-opus-4-6");

      // Step 2: Agent reads config and enabled URLs for its context
      const agentStores = createStores(dbUri);
      const model = await agentStores.configStore.get("model");
      const urls = await agentStores.urlStore.listEnabled();
      expect(model).toBe("claude-opus-4-6");
      expect(urls.some((u) => u.url === "https://api.example.com/docs")).toBe(true);

      // Step 3: Agent logs the interaction
      await agentStores.auditStore.write({
        channel: "C_E2E",
        thread_ts: "T_E2E",
        user_id: "U_USER",
        prompt: "Explain the API",
        response: "The API provides...",
        model: model!,
        duration_ms: 1500,
      });

      // Step 4: Admin reviews the audit log
      const adminStores = createStores(dbUri);
      const audit = await adminStores.auditStore.listByThread("C_E2E", "T_E2E");
      expect(audit).toHaveLength(1);
      expect(audit[0].prompt).toBe("Explain the API");
      expect(audit[0].model).toBe("claude-opus-4-6");
      expect(audit[0].duration_ms).toBe(1500);
    });
  });
});
