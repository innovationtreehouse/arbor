import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the agent SDK before importing the module under test
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

const { query } = await import("@anthropic-ai/claude-agent-sdk");
const { runAgent } = await import("../agent.js");


process.env.AWS_REGION = "us-east-1";
process.env.SLACK_BOT_TOKEN = "xoxb-test";

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("runAgent", () => {
  it("returns the result from a successful query", async () => {
    vi.mocked(query).mockReturnValue(
      (async function* () {
        yield { result: "Here is the document you requested." };
      })()
    );

    const result = await runAgent("find the Q4 report", "You are Squirrel.");
    expect(result).toBe("Here is the document you requested.");
  });

  it("returns fallback message when query yields no result", async () => {
    vi.mocked(query).mockReturnValue(
      (async function* () {
        yield { type: "assistant", content: [] };
      })()
    );

    const result = await runAgent("find something", "system");
    expect(result).toBe("I was unable to generate a response.");
  });

  it("uses the last result when multiple result messages are yielded", async () => {
    vi.mocked(query).mockReturnValue(
      (async function* () {
        yield { result: "first" };
        yield { result: "second" };
      })()
    );

    const result = await runAgent("prompt", "system");
    expect(result).toBe("second");
  });

  it("passes systemPrompt and model to query options", async () => {
    vi.mocked(query).mockReturnValue(
      (async function* () {
        yield { result: "ok" };
      })()
    );
    process.env.MODEL = "claude-opus-4-6";

    await runAgent("test prompt", "test system");

    const callArgs = vi.mocked(query).mock.calls[0][0];
    expect(callArgs.prompt).toBe("test prompt");
    expect(callArgs.options?.systemPrompt).toBe("test system");
    expect(callArgs.options?.model).toBe("claude-opus-4-6");
    delete process.env.MODEL;
  });

  it("falls back to claude-sonnet-4-6 when MODEL is not set", async () => {
    delete process.env.MODEL;
    vi.mocked(query).mockReturnValue(
      (async function* () {
        yield { result: "ok" };
      })()
    );

    await runAgent("prompt", "system");

    const callArgs = vi.mocked(query).mock.calls[0][0];
    expect(callArgs.options?.model).toBe("claude-sonnet-4-6");
  });

  it("includes gdrive, github, and urlFetcher MCP servers", async () => {
    vi.mocked(query).mockReturnValue(
      (async function* () {
        yield { result: "ok" };
      })()
    );
    process.env.GOOGLE_CREDENTIALS = '{"type":"service_account"}';
    process.env.GITHUB_TOKEN = "ghp_test";

    await runAgent("prompt", "system");

    const { mcpServers } = vi.mocked(query).mock.calls[0][0].options ?? {};
    expect(mcpServers).toHaveProperty("gdrive");
    expect(mcpServers).toHaveProperty("github");
    expect(mcpServers).toHaveProperty("urlFetcher");
  });

  it("passes model argument to query, taking priority over MODEL env var", async () => {
    process.env.MODEL = "claude-opus-4-6";
    vi.mocked(query).mockReturnValue(
      (async function* () {
        yield { result: "ok" };
      })()
    );

    await runAgent("prompt", "system", "claude-haiku-4-5-20251001");

    const callArgs = vi.mocked(query).mock.calls[0][0];
    expect(callArgs.options?.model).toBe("claude-haiku-4-5-20251001");
    delete process.env.MODEL;
  });

  it("passes DATABASE_URL to urlFetcher MCP env", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    vi.mocked(query).mockReturnValue(
      (async function* () {
        yield { result: "ok" };
      })()
    );

    await runAgent("prompt", "system");

    const { mcpServers } = vi.mocked(query).mock.calls[0][0].options ?? {};
    expect((mcpServers as any)?.urlFetcher?.env?.DATABASE_URL).toBe("postgres://localhost/test");
    expect((mcpServers as any)?.urlFetcher?.env).not.toHaveProperty("DYNAMODB_TABLE");
  });
});
