import { describe, expect, it } from "vitest";
import { buildPrompt, buildSystemPrompt, defaultSystemPrompt, DEFAULT_USER_PROMPT_TEMPLATE } from "../prompt.js";
import type { SlackMessage } from "../prompt.js";

describe("buildSystemPrompt", () => {
  it("mentions key data sources", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Google Drive");
    expect(prompt).toContain("GitHub");
    expect(prompt).toContain("URL Fetcher");
  });

  it("includes character limit guidance", () => {
    expect(buildSystemPrompt()).toContain("3900");
  });

  it("returns the override when provided", () => {
    expect(buildSystemPrompt("custom prompt")).toBe("custom prompt");
  });

  it("returns the default when override is undefined", () => {
    expect(buildSystemPrompt(undefined)).toBe(defaultSystemPrompt());
  });

  it("returns the default when override is empty string", () => {
    expect(buildSystemPrompt("" || undefined)).toBe(defaultSystemPrompt());
  });
});

describe("buildPrompt", () => {
  it("returns just the current text when history is empty", () => {
    expect(buildPrompt([], "hello")).toBe("hello");
  });

  it("returns just the current text when history has only the current message", () => {
    const history: SlackMessage[] = [{ user: "U1", text: "hello" }];
    expect(buildPrompt(history, "hello")).toBe("hello");
  });

  it("prefixes thread context when there is prior history", () => {
    const history: SlackMessage[] = [
      { user: "U1", text: "first message" },
      { bot_id: "B1", text: "bot reply" },
      { user: "U1", text: "current message" },
    ];
    const result = buildPrompt(history, "current message");
    expect(result).toContain("Thread context:");
    expect(result).toContain("first message");
    expect(result).toContain("Squirrel");
    expect(result).toContain("Current message:");
    expect(result).toContain("current message");
  });

  it("excludes the last history item (current message) from context", () => {
    const history: SlackMessage[] = [
      { user: "U1", text: "earlier" },
      { user: "U1", text: "this is the current one" },
    ];
    const result = buildPrompt(history, "this is the current one");
    expect(result).toContain("earlier");
    const occurrences = result.split("this is the current one").length - 1;
    expect(occurrences).toBe(1);
  });

  it("labels bot messages as Squirrel", () => {
    const history: SlackMessage[] = [
      { bot_id: "B1", text: "I found the document." },
      { user: "U1", text: "thanks" },
    ];
    const result = buildPrompt(history, "thanks");
    expect(result).toContain("Squirrel: I found the document.");
  });

  it("labels user messages with their user ID", () => {
    const history: SlackMessage[] = [
      { user: "U_ALICE", text: "find the Q4 report" },
      { user: "U_ALICE", text: "current" },
    ];
    const result = buildPrompt(history, "current");
    expect(result).toContain("U_ALICE");
  });

  it("handles messages with no user or bot_id", () => {
    const history: SlackMessage[] = [
      { text: "mystery message" },
      { user: "U1", text: "current" },
    ];
    expect(() => buildPrompt(history, "current")).not.toThrow();
  });

  it("uses a custom template when provided", () => {
    const history: SlackMessage[] = [
      { user: "U1", text: "prior" },
      { user: "U1", text: "current" },
    ];
    const result = buildPrompt(history, "current", "CTX:{{context}} MSG:{{message}}");
    expect(result).toContain("CTX:");
    expect(result).toContain("MSG:current");
    expect(result).toContain("prior");
  });

  it("falls back to default template when undefined", () => {
    const history: SlackMessage[] = [
      { user: "U1", text: "prior" },
      { user: "U1", text: "current" },
    ];
    expect(buildPrompt(history, "current", undefined)).toContain("Thread context:");
  });

  it("DEFAULT_USER_PROMPT_TEMPLATE contains both placeholders", () => {
    expect(DEFAULT_USER_PROMPT_TEMPLATE).toContain("{{context}}");
    expect(DEFAULT_USER_PROMPT_TEMPLATE).toContain("{{message}}");
  });
});
