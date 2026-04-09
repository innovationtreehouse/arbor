import * as crypto from "crypto";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  ECSClient,
  ListTasksCommand,
  RunTaskCommand,
} from "@aws-sdk/client-ecs";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { ChannelRateLimiter } from "./rate-limiter.js";
import { PostgresConfigStore } from "@arbor/db";

const sqsClient = new SQSClient({});
const ecsClient = new ECSClient({});
const configStore = new PostgresConfigStore(process.env.DATABASE_URL!);
const rateLimiter = new ChannelRateLimiter(configStore);
const AGENT_NAME = process.env.AGENT_NAME ?? "Squirrel";
declare const __GIT_SHA__: string | undefined;
declare const __BUILD_TIME__: string | undefined;
const GIT_SHA = typeof __GIT_SHA__ !== "undefined" ? __GIT_SHA__ : "dev";
const BUILD_TIME = typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : "unknown";

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

function verifySlackSignature(
  body: string,
  timestamp: string,
  signature: string
): boolean {
  const signingSecret = process.env.SLACK_SIGNING_SECRET!;
  const age = Math.abs(Date.now() / 1000 - parseInt(timestamp, 10));
  if (age > 300) return false;

  const hmac = crypto
    .createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex");

  const expected = `v0=${hmac}`;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature)
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const rawBody = event.body ?? "";
  const body = event.isBase64Encoded
    ? Buffer.from(rawBody, "base64").toString("utf8")
    : rawBody;
  const timestamp = event.headers["x-slack-request-timestamp"] ?? "";
  const signature = event.headers["x-slack-signature"] ?? "";

  if (!verifySlackSignature(body, timestamp, signature)) {
    return { statusCode: 401, body: "Invalid signature" };
  }

  const path = event.rawPath;

  if (path === "/slack/events") {
    return handleEvent(body);
  }
  if (path === "/slack/commands") {
    return handleCommand(body);
  }

  return { statusCode: 404, body: "Not found" };
};

// ---------------------------------------------------------------------------
// Event handler (app_mention, message.channels, message.im)
// ---------------------------------------------------------------------------

async function handleEvent(rawBody: string) {
  const body = JSON.parse(rawBody);
  const ev = body.event;
  console.log("event type:", body.type, "event subtype:", ev?.type, "channel_type:", ev?.channel_type, "bot_id:", ev?.bot_id);

  // URL verification handshake
  if (body.type === "url_verification") {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge: body.challenge }),
    };
  }

  if (body.type !== "event_callback") {
    return { statusCode: 200, body: "" };
  }

  // Ignore bot messages (prevent self-loops)
  if (ev?.bot_id) {
    return { statusCode: 200, body: "" };
  }

  // Ignore message edits, deletions, and other subtypes
  if (ev?.type === "message" && ev?.subtype) {
    return { statusCode: 200, body: "" };
  }

  const isAppMention = ev?.type === "app_mention";
  const isChannelMessage = ev?.type === "message" && ev?.channel_type === "channel";
  const isDirectMessage = ev?.type === "message" && ev?.channel_type === "im";

  if (!isAppMention && !isChannelMessage && !isDirectMessage) {
    return { statusCode: 200, body: "" };
  }

  // If BOT_USER_ID is set, skip channel messages that @mention the bot — app_mention
  // will handle those, avoiding double-processing the same message.
  const botUserId = process.env.BOT_USER_ID;
  if (isChannelMessage && botUserId && ev?.text?.includes(`<@${botUserId}>`)) {
    return { statusCode: 200, body: "" };
  }

  await ensureAgentRunning().catch((err) => {
    console.error("ensureAgentRunning failed:", err);
    throw err;
  });

  const channel = ev.channel as string;
  const holdoff = await rateLimiter.recordAndCheck(channel);

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: process.env.SQS_QUEUE_URL!,
      MessageBody: JSON.stringify({
        channel,
        thread_ts: ev.thread_ts ?? ev.ts,
        is_thread: !!ev.thread_ts && ev.thread_ts !== ev.ts,
        event_ts: ev.ts,
        user: ev.user,
        text: ev.text,
        holdoff,
      }),
    })
  );

  return { statusCode: 200, body: "" };
}

async function ensureAgentRunning() {
  const listResult = await ecsClient.send(
    new ListTasksCommand({
      cluster: process.env.ECS_CLUSTER!,
      family: process.env.ECS_TASK_FAMILY!,
      desiredStatus: "RUNNING",
    })
  );

  if (listResult.taskArns && listResult.taskArns.length > 0) return;

  await ecsClient.send(
    new RunTaskCommand({
      cluster: process.env.ECS_CLUSTER!,
      taskDefinition: process.env.ECS_TASK_FAMILY!,
      launchType: "FARGATE",
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: process.env.SUBNET_IDS!.split(","),
          securityGroups: process.env.SECURITY_GROUP_IDS!.split(","),
          assignPublicIp: "ENABLED",
        },
      },
    })
  );
}

// ---------------------------------------------------------------------------
// Admin slash command handler (/squirrel-admin)
// ---------------------------------------------------------------------------

async function handleCommand(rawBody: string) {
  const params = new URLSearchParams(rawBody);
  const userId = params.get("user_id") ?? "";
  const text = (params.get("text") ?? "").trim();
  const responseUrl = params.get("response_url") ?? "";

  const adminIds = (process.env.ADMIN_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (!adminIds.includes(userId)) {
    return ephemeral("You are not authorized to use `/squirrel-admin`.");
  }

  const [subcommand, ...args] = text.split(/\s+/);

  // Help and unknown subcommands respond inline (no DB work, always fast).
  if (!subcommand || subcommand === "help") {
    return ephemeral(
      `*${AGENT_NAME} Admin Commands:*\n` +
        "• `/squirrel-admin list` — show all configured URLs\n" +
        "• `/squirrel-admin add <url> <description>` — add a URL to the allowlist\n" +
        "• `/squirrel-admin remove <url>` — remove a URL\n" +
        "• `/squirrel-admin test <url>` — preview URL content\n" +
        "• `/squirrel-admin model [<model-id>]` — show or set the active Claude model\n" +
        "• `/squirrel-admin prompt show [system|user]` — show active prompt(s)\n" +
        "• `/squirrel-admin prompt set system|user <text>` — override a prompt\n" +
        "• `/squirrel-admin prompt reset [system|user]` — reset prompt(s) to default\n" +
        "• `/squirrel-admin audit [<limit>]` — show recent agent interactions\n" +
        "• `/squirrel-admin audit-thread <channel> <thread_ts>` — show interactions for a thread\n" +
        "• `/squirrel-admin token-limit [<channel|default> [<limit>]]` — show or set per-channel token limit\n" +
        "• `/squirrel-admin check` — verify connectivity to all data sources\n" +
        "• `/squirrel-admin help` — show this message\n" +
        "_Built `" + GIT_SHA + "` at " + BUILD_TIME + "_"
    );
  }

  // All other subcommands hit the DB. Enqueue via SQS so Lambda can return
  // the 200 ack to Slack within 3 seconds. The agent picks up the message
  // and posts the result to response_url (valid for 30 minutes).
  await ensureAgentRunning().catch((err) => {
    console.error("ensureAgentRunning failed:", err);
    throw err;
  });

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: process.env.SQS_QUEUE_URL!,
      MessageBody: JSON.stringify({
        type: "admin_command",
        subcommand,
        args,
        userId,
        responseUrl,
      }),
    })
  );

  return { statusCode: 200, body: "" };
}

function ephemeral(text: string) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", text }),
  };
}
