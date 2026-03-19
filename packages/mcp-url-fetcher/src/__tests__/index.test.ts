import { beforeEach, describe, expect, it, vi } from "vitest";
import { callToolHandler, listToolsHandler } from "../index.js";
import { UrlConfig } from "../config.js";

// Mock UrlConfig so we control allowlist contents without DynamoDB
vi.mock("../config.js", () => {
  const allowed = new Map<string, { url: string; description: string; enabled: boolean; added_by: string; added_at: string }>([
    ["https://docs.example.com", { url: "https://docs.example.com", description: "API Docs", enabled: true, added_by: "U1", added_at: "" }],
  ]);

  const MockUrlConfig = vi.fn().mockImplementation(function () {
    return {
      load: vi.fn().mockResolvedValue(undefined),
      startPolling: vi.fn(),
      isAllowed: vi.fn((url: string) => allowed.has(url)),
      getAll: vi.fn(() => Array.from(allowed.values())),
      getDescription: vi.fn((url: string) => allowed.get(url)?.description ?? ""),
    };
  });

  return { UrlConfig: MockUrlConfig };
});

let config: InstanceType<typeof UrlConfig>;

beforeEach(() => {
  config = new UrlConfig({} as any);
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// listToolsHandler
// ---------------------------------------------------------------------------

describe("listToolsHandler", () => {
  it("returns exactly two tools: url_list and url_fetch", () => {
    const result = listToolsHandler();
    expect(result.tools).toHaveLength(2);
    expect(result.tools.map((t) => t.name)).toEqual(["url_list", "url_fetch"]);
  });

  it("url_fetch tool has 'url' as a required parameter", () => {
    const fetchTool = listToolsHandler().tools.find((t) => t.name === "url_fetch")!;
    expect(fetchTool.inputSchema.required).toContain("url");
  });
});

// ---------------------------------------------------------------------------
// callToolHandler — url_list
// ---------------------------------------------------------------------------

describe("callToolHandler: url_list", () => {
  it("returns a formatted list of configured URLs", async () => {
    const result = await callToolHandler(config, "url_list", {});
    expect(result.content[0].text).toContain("https://docs.example.com");
    expect(result.content[0].text).toContain("API Docs");
  });

  it("returns 'no URLs' message when allowlist is empty", async () => {
    vi.mocked(config.getAll).mockReturnValueOnce([]);
    const result = await callToolHandler(config, "url_list", {});
    expect(result.content[0].text).toContain("No URLs are currently configured");
  });
});

// ---------------------------------------------------------------------------
// callToolHandler — url_fetch
// ---------------------------------------------------------------------------

describe("callToolHandler: url_fetch", () => {
  it("returns error when url parameter is missing", async () => {
    const result = await callToolHandler(config, "url_fetch", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Missing required parameter");
  });

  it("returns error when URL is not on allowlist", async () => {
    const result = await callToolHandler(config, "url_fetch", { url: "https://evil.com" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not on allowlist");
  });

  it("returns fetched content for an allowed URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => "text/html; charset=utf-8" },
        text: async () => "<html>Hello docs</html>",
      })
    );

    const result = await callToolHandler(config, "url_fetch", {
      url: "https://docs.example.com",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("https://docs.example.com");
    expect(result.content[0].text).toContain("API Docs");
    expect(result.content[0].text).toContain("Hello docs");
  });

  it("includes description in output when available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => "text/plain" },
        text: async () => "content",
      })
    );

    const result = await callToolHandler(config, "url_fetch", {
      url: "https://docs.example.com",
    });

    expect(result.content[0].text).toContain("(API Docs)");
  });

  it("returns error on non-ok HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: "Service Unavailable" })
    );

    const result = await callToolHandler(config, "url_fetch", {
      url: "https://docs.example.com",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("503");
  });

  it("returns error for non-text content type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => "application/octet-stream" },
      })
    );

    const result = await callToolHandler(config, "url_fetch", {
      url: "https://docs.example.com",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unsupported content type");
  });

  it("accepts application/json content type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        text: async () => '{"key":"value"}',
      })
    );

    const result = await callToolHandler(config, "url_fetch", {
      url: "https://docs.example.com",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("key");
  });

  it("truncates content exceeding MAX_CONTENT_CHARS", async () => {
    const hugeContent = "a".repeat(25_000);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => "text/plain" },
        text: async () => hugeContent,
      })
    );

    const result = await callToolHandler(config, "url_fetch", {
      url: "https://docs.example.com",
    });

    expect(result.content[0].text).toContain("truncated");
  });

  it("returns error on fetch exception", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const result = await callToolHandler(config, "url_fetch", {
      url: "https://docs.example.com",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("ECONNREFUSED");
  });
});

// ---------------------------------------------------------------------------
// callToolHandler — unknown tool
// ---------------------------------------------------------------------------

describe("callToolHandler: unknown tool", () => {
  it("returns error for an unrecognised tool name", async () => {
    const result = await callToolHandler(config, "nonexistent_tool", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown tool");
  });
});
