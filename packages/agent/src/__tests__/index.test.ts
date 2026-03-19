import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

vi.mock("../slack.js", () => ({
  fetchThreadHistory: vi.fn().mockResolvedValue([]),
  postMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../agent.js", () => ({
  runAgent: vi.fn().mockResolvedValue("Agent response"),
}));

vi.mock("../prompt.js", () => ({
  buildPrompt: vi.fn().mockReturnValue("built prompt"),
  buildSystemPrompt: vi.fn().mockReturnValue("system prompt"),
}));

const sqsMock = mockClient(SQSClient);

const { fetchThreadHistory, postMessage } = await import("../slack.js");
const { runAgent } = await import("../agent.js");
const { buildPrompt, buildSystemPrompt } = await import("../prompt.js");
const { processEvent } = await import("../index.js");

const baseEvent = {
  channel: "C_CHAN",
  thread_ts: "1.0",
  event_ts: "1.1",
  user: "U1",
  text: "@Squirrel find the doc",
};

beforeEach(() => {
  sqsMock.reset();
  vi.mocked(fetchThreadHistory).mockClear();
  vi.mocked(postMessage).mockClear();
  vi.mocked(runAgent).mockClear();
  vi.mocked(buildPrompt).mockClear();
  vi.mocked(buildSystemPrompt).mockClear();

  process.env.SQS_QUEUE_URL = "https://sqs.test/queue";
  process.env.AWS_REGION = "us-east-1";
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
});

describe("processEvent", () => {
  it("fetches thread history, runs agent, and posts response", async () => {
    const history = [{ user: "U1", text: "earlier message" }];
    vi.mocked(fetchThreadHistory).mockResolvedValueOnce(history);
    vi.mocked(runAgent).mockResolvedValueOnce("Here is your answer.");

    await processEvent(baseEvent);

    expect(fetchThreadHistory).toHaveBeenCalledWith("C_CHAN", "1.0");
    expect(buildPrompt).toHaveBeenCalledWith(history, baseEvent.text);
    expect(buildSystemPrompt).toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledWith("built prompt", "system prompt");
    expect(postMessage).toHaveBeenCalledWith("C_CHAN", "1.0", "Here is your answer.");
  });

  it("passes the agent response to postMessage", async () => {
    vi.mocked(runAgent).mockResolvedValueOnce("Custom agent answer");
    await processEvent(baseEvent);
    expect(postMessage).toHaveBeenCalledWith("C_CHAN", "1.0", "Custom agent answer");
  });

  it("propagates errors from fetchThreadHistory", async () => {
    vi.mocked(fetchThreadHistory).mockRejectedValueOnce(new Error("Slack API error"));
    await expect(processEvent(baseEvent)).rejects.toThrow("Slack API error");
  });

  it("propagates errors from runAgent", async () => {
    vi.mocked(runAgent).mockRejectedValueOnce(new Error("Agent failed"));
    await expect(processEvent(baseEvent)).rejects.toThrow("Agent failed");
  });
});
