import * as crypto from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  ECSClient,
  ListTasksCommand,
  RunTaskCommand,
} from "@aws-sdk/client-ecs";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { UrlStore, UrlEntry } from "@arbor/db";

// ---------------------------------------------------------------------------
// Mock @arbor/db before importing the handler
// ---------------------------------------------------------------------------

const mockStore: UrlStore = {
  listEnabled: vi.fn().mockResolvedValue([]),
  listAll: vi.fn().mockResolvedValue([]),
  upsert: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  count: vi.fn().mockResolvedValue(0),
};

vi.mock("@arbor/db", () => ({
  PostgresUrlStore: vi.fn().mockImplementation(function () {
    return mockStore;
  }),
}));

const { handler } = await import("../index.js");

const sqsMock = mockClient(SQSClient);
const ecsMock = mockClient(ECSClient);

const TEST_SECRET = "test-signing-secret";

process.env.SLACK_SIGNING_SECRET = TEST_SECRET;
process.env.SQS_QUEUE_URL = "https://sqs.test/queue";
process.env.ECS_CLUSTER = "arbor-cluster";
process.env.ECS_TASK_FAMILY = "arbor-agent";
process.env.ECS_TASK_DEFINITION = "arbor-agent:1";
process.env.SUBNET_IDS = "subnet-1,subnet-2";
process.env.SECURITY_GROUP_IDS = "sg-1";
process.env.ADMIN_USER_IDS = "U_ADMIN,U_ADMIN2";

function ts(offsetSeconds = 0) {
  return String(Math.floor(Date.now() / 1000) + offsetSeconds);
}

function sign(body: string, timestamp: string, secret = TEST_SECRET) {
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex");
  return `v0=${hmac}`;
}

function makeEvent(options: {
  path?: string;
  body?: string;
  timestamp?: string;
  signature?: string;
}) {
  const body = options.body ?? "";
  const timestamp = options.timestamp ?? ts();
  const sig = options.signature ?? sign(body, timestamp);
  return {
    rawPath: options.path ?? "/slack/events",
    body,
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": sig,
    },
  } as any;
}

beforeEach(() => {
  sqsMock.reset();
  ecsMock.reset();
  vi.mocked(mockStore.listAll).mockResolvedValue([]);
  vi.mocked(mockStore.listEnabled).mockResolvedValue([]);
  vi.mocked(mockStore.upsert).mockResolvedValue(undefined);
  vi.mocked(mockStore.delete).mockResolvedValue(undefined);
  vi.mocked(mockStore.count).mockResolvedValue(0);
});

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

describe("signature verification", () => {
  it("rejects a missing / bad signature with 401", async () => {
    const res = await handler(
      makeEvent({ signature: "v0=badhash" }),
      {} as any,
      {} as any
    );
    expect(res?.statusCode).toBe(401);
  });

  it("rejects a stale timestamp (>5 min old)", async () => {
    const body = "{}";
    const staleTs = ts(-400);
    const res = await handler(
      makeEvent({ body, timestamp: staleTs, signature: sign(body, staleTs) }),
      {} as any,
      {} as any
    );
    expect(res?.statusCode).toBe(401);
  });

  it("accepts a valid signature", async () => {
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
    ecsMock.on(RunTaskCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({});
    const body = JSON.stringify({ type: "event_callback", event: { type: "app_mention", channel: "C1", ts: "1.0", text: "hi", user: "U1" } });
    const res = await handler(makeEvent({ body }), {} as any, {} as any);
    expect(res?.statusCode).not.toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe("routing", () => {
  it("returns 404 for unknown path", async () => {
    const body = "";
    const res = await handler(
      makeEvent({ path: "/unknown", body }),
      {} as any,
      {} as any
    );
    expect(res?.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// /slack/events — event handler
// ---------------------------------------------------------------------------

describe("/slack/events", () => {
  it("responds to url_verification challenge", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const res = await handler(makeEvent({ body }), {} as any, {} as any);
    expect(res?.statusCode).toBe(200);
    expect(JSON.parse(res?.body ?? "")).toEqual({ challenge: "abc123" });
  });

  it("ignores non-mention events", async () => {
    const body = JSON.stringify({ type: "event_callback", event: { type: "message" } });
    const res = await handler(makeEvent({ body }), {} as any, {} as any);
    expect(res?.statusCode).toBe(200);
    expect(sqsMock.calls()).toHaveLength(0);
  });

  it("ignores bot messages to prevent self-loops", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      event: { type: "app_mention", bot_id: "B123", channel: "C1", ts: "1.0", text: "hi" },
    });
    const res = await handler(makeEvent({ body }), {} as any, {} as any);
    expect(res?.statusCode).toBe(200);
    expect(sqsMock.calls()).toHaveLength(0);
  });

  it("forwards app_mention to SQS when ECS task is already running", async () => {
    ecsMock.on(ListTasksCommand).resolves({ taskArns: ["arn:task:1"] });
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "msg-1" });

    const event = { type: "app_mention", channel: "C1", ts: "1.0", thread_ts: "1.0", text: "@Squirrel hi", user: "U1" };
    const body = JSON.stringify({ type: "event_callback", event });

    const res = await handler(makeEvent({ body }), {} as any, {} as any);
    expect(res?.statusCode).toBe(200);
    expect(sqsMock.calls()).toHaveLength(1);
    expect(ecsMock.commandCalls(RunTaskCommand)).toHaveLength(0);
  });

  it("starts ECS task when not running, then forwards to SQS", async () => {
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
    ecsMock.on(RunTaskCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "msg-1" });

    const event = { type: "app_mention", channel: "C1", ts: "1.0", text: "@Squirrel hi", user: "U1" };
    const body = JSON.stringify({ type: "event_callback", event });

    const res = await handler(makeEvent({ body }), {} as any, {} as any);
    expect(res?.statusCode).toBe(200);
    expect(ecsMock.commandCalls(RunTaskCommand)).toHaveLength(1);
    expect(sqsMock.calls()).toHaveLength(1);
  });

  it("uses event.ts as thread_ts when thread_ts is absent", async () => {
    ecsMock.on(ListTasksCommand).resolves({ taskArns: ["arn:1"] });
    sqsMock.on(SendMessageCommand).resolves({});

    const event = { type: "app_mention", channel: "C1", ts: "9.9", text: "hi", user: "U1" };
    const body = JSON.stringify({ type: "event_callback", event });

    await handler(makeEvent({ body }), {} as any, {} as any);

    const sent = JSON.parse(sqsMock.calls()[0].args[0].input.MessageBody!);
    expect(sent.thread_ts).toBe("9.9");
  });
});

// ---------------------------------------------------------------------------
// /slack/commands — admin handler
// ---------------------------------------------------------------------------

describe("/slack/commands", () => {
  function makeCommandEvent(userId: string, text: string) {
    const body = new URLSearchParams({ user_id: userId, command: "/squirrel-admin", text }).toString();
    return makeEvent({ path: "/slack/commands", body });
  }

  it("rejects non-admin users", async () => {
    const res = await handler(makeCommandEvent("U_NOBODY", "list"), {} as any, {} as any);
    expect(res?.statusCode).toBe(200);
    const payload = JSON.parse(res?.body ?? "");
    expect(payload.text).toContain("not authorized");
  });

  it("shows help for unknown subcommand", async () => {
    const res = await handler(makeCommandEvent("U_ADMIN", ""), {} as any, {} as any);
    const payload = JSON.parse(res?.body ?? "");
    expect(payload.text).toContain("squirrel-admin list");
  });

  it("list — returns empty message when no URLs configured", async () => {
    vi.mocked(mockStore.listAll).mockResolvedValueOnce([]);
    const res = await handler(makeCommandEvent("U_ADMIN", "list"), {} as any, {} as any);
    const payload = JSON.parse(res?.body ?? "");
    expect(payload.text).toContain("No URLs configured");
  });

  it("list — shows configured URLs", async () => {
    const item: UrlEntry = { url: "https://example.com", description: "Example", added_by: "U1", enabled: true, added_at: "" };
    vi.mocked(mockStore.listAll).mockResolvedValueOnce([item]);
    const res = await handler(makeCommandEvent("U_ADMIN", "list"), {} as any, {} as any);
    const payload = JSON.parse(res?.body ?? "");
    expect(payload.text).toContain("https://example.com");
    expect(payload.text).toContain("Example");
  });

  it("add — rejects missing description", async () => {
    const res = await handler(makeCommandEvent("U_ADMIN", "add https://example.com"), {} as any, {} as any);
    const payload = JSON.parse(res?.body ?? "");
    expect(payload.text).toContain("Usage:");
  });

  it("add — rejects non-https URL", async () => {
    const res = await handler(makeCommandEvent("U_ADMIN", "add http://example.com My site"), {} as any, {} as any);
    const payload = JSON.parse(res?.body ?? "");
    expect(payload.text).toContain("must start with");
  });

  it("add — rejects when URL limit reached", async () => {
    process.env.MAX_URL_COUNT = "1";
    vi.mocked(mockStore.count).mockResolvedValueOnce(1);
    const res = await handler(makeCommandEvent("U_ADMIN", "add https://new.com New site"), {} as any, {} as any);
    const payload = JSON.parse(res?.body ?? "");
    expect(payload.text).toContain("limit");
    delete process.env.MAX_URL_COUNT;
  });

  it("add — stores a valid URL via the store", async () => {
    vi.mocked(mockStore.count).mockResolvedValueOnce(0);

    const res = await handler(
      makeCommandEvent("U_ADMIN", "add https://docs.example.com Our API docs"),
      {} as any,
      {} as any
    );
    const payload = JSON.parse(res?.body ?? "");
    expect(payload.text).toContain("Added");
    expect(payload.text).toContain("https://docs.example.com");

    expect(vi.mocked(mockStore.upsert)).toHaveBeenCalledWith({
      url: "https://docs.example.com",
      description: "Our API docs",
      added_by: "U_ADMIN",
      enabled: true,
    });
  });

  it("remove — deletes the URL via the store", async () => {
    const res = await handler(
      makeCommandEvent("U_ADMIN", "remove https://docs.example.com"),
      {} as any,
      {} as any
    );
    const payload = JSON.parse(res?.body ?? "");
    expect(payload.text).toContain("Removed");
    expect(vi.mocked(mockStore.delete)).toHaveBeenCalledWith("https://docs.example.com");
  });

  it("remove — rejects missing URL argument", async () => {
    const res = await handler(makeCommandEvent("U_ADMIN", "remove"), {} as any, {} as any);
    const payload = JSON.parse(res?.body ?? "");
    expect(payload.text).toContain("Usage:");
  });

  it("test — rejects missing URL argument", async () => {
    const res = await handler(makeCommandEvent("U_ADMIN", "test"), {} as any, {} as any);
    const payload = JSON.parse(res?.body ?? "");
    expect(payload.text).toContain("Usage:");
  });

  it("test — rejects non-https URL", async () => {
    const res = await handler(makeCommandEvent("U_ADMIN", "test http://bad.com"), {} as any, {} as any);
    const payload = JSON.parse(res?.body ?? "");
    expect(payload.text).toContain("must start with");
  });

  it("test — returns preview on successful fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "Hello world content",
        headers: { get: () => "text/html" },
      })
    );

    const res = await handler(
      makeCommandEvent("U_ADMIN", "test https://example.com"),
      {} as any,
      {} as any
    );
    const payload = JSON.parse(res?.body ?? "");
    expect(payload.text).toContain("reachable");
    expect(payload.text).toContain("Hello world content");
    vi.unstubAllGlobals();
  });

  it("test — reports HTTP error status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" })
    );

    const res = await handler(
      makeCommandEvent("U_ADMIN", "test https://example.com"),
      {} as any,
      {} as any
    );
    const payload = JSON.parse(res?.body ?? "");
    expect(payload.text).toContain("404");
    vi.unstubAllGlobals();
  });

  it("test — reports network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
    );

    const res = await handler(
      makeCommandEvent("U_ADMIN", "test https://example.com"),
      {} as any,
      {} as any
    );
    const payload = JSON.parse(res?.body ?? "");
    expect(payload.text).toContain("ECONNREFUSED");
    vi.unstubAllGlobals();
  });
});
