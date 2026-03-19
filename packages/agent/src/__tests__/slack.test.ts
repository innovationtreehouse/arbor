import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPostMessage = vi.fn().mockResolvedValue({ ok: true });
const mockReplies = vi.fn().mockResolvedValue({ ok: true, messages: [] });

vi.mock("@slack/web-api", () => ({
  WebClient: vi.fn().mockImplementation(function () {
    return {
      chat: { postMessage: mockPostMessage },
      conversations: { replies: mockReplies },
    };
  }),
}));

// Import after mocking
const { fetchThreadHistory, postMessage } = await import("../slack.js");

beforeEach(() => {
  mockPostMessage.mockClear();
  mockReplies.mockClear();
});

describe("fetchThreadHistory", () => {
  it("returns messages from conversations.replies", async () => {
    const messages = [
      { user: "U1", text: "hello", ts: "1.0" },
      { bot_id: "B1", text: "hi there", ts: "2.0" },
    ];
    mockReplies.mockResolvedValueOnce({ ok: true, messages });

    const result = await fetchThreadHistory("C_CHANNEL", "1.0");
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("hello");
  });

  it("passes channel, ts, and limit to the API", async () => {
    mockReplies.mockResolvedValueOnce({ ok: true, messages: [] });

    await fetchThreadHistory("C_TEST", "9.9");

    expect(mockReplies).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C_TEST", ts: "9.9", limit: 50 })
    );
  });

  it("returns empty array when messages is undefined", async () => {
    mockReplies.mockResolvedValueOnce({ ok: true });
    const result = await fetchThreadHistory("C1", "1.0");
    expect(result).toEqual([]);
  });
});

describe("postMessage", () => {
  it("posts a message to the correct channel and thread", async () => {
    await postMessage("C_CHAN", "1.0", "Hello Slack");
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C_CHAN",
        thread_ts: "1.0",
        text: "Hello Slack",
      })
    );
  });

  it("truncates messages longer than 3900 characters", async () => {
    const longText = "x".repeat(4000);
    await postMessage("C1", "1.0", longText);

    const call = mockPostMessage.mock.calls[0][0];
    expect(call.text.length).toBeLessThanOrEqual(3900);
    expect(call.text.endsWith("…")).toBe(true);
  });

  it("does not truncate messages at exactly 3900 characters", async () => {
    const text = "y".repeat(3900);
    await postMessage("C1", "1.0", text);
    expect(mockPostMessage.mock.calls[0][0].text).toBe(text);
  });

  it("does not truncate short messages", async () => {
    await postMessage("C1", "1.0", "short");
    expect(mockPostMessage.mock.calls[0][0].text).toBe("short");
  });
});
