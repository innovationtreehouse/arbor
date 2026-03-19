import { WebClient } from "@slack/web-api";
import type { SlackMessage } from "./prompt.js";

const client = new WebClient(process.env.SLACK_BOT_TOKEN);

const THREAD_HISTORY_LIMIT = parseInt(
  process.env.THREAD_HISTORY_LIMIT ?? "50",
  10
);

export async function fetchThreadHistory(
  channel: string,
  threadTs: string
): Promise<SlackMessage[]> {
  const result = await client.conversations.replies({
    channel,
    ts: threadTs,
    limit: THREAD_HISTORY_LIMIT,
  });

  return (result.messages ?? []) as SlackMessage[];
}

export async function postMessage(
  channel: string,
  threadTs: string,
  text: string
): Promise<void> {
  // Slack blocks messages over 4000 chars; truncate with an indicator
  const truncated =
    text.length > 3900 ? text.slice(0, 3897) + "…" : text;

  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: truncated,
  });
}

export async function postEphemeral(
  channel: string,
  userId: string,
  text: string
): Promise<void> {
  await client.chat.postEphemeral({
    channel,
    user: userId,
    text,
  });
}
