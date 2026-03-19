import * as crypto from "crypto";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  ECSClient,
  ListTasksCommand,
  RunTaskCommand,
} from "@aws-sdk/client-ecs";
import { PostgresUrlStore, type UrlStore } from "@arbor/db";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";

const sqsClient = new SQSClient({});
const ecsClient = new ECSClient({});
const store: UrlStore = new PostgresUrlStore(process.env.DATABASE_URL!);
const AGENT_NAME = process.env.AGENT_NAME ?? "Squirrel";

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
  const body = event.body ?? "";
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
// Event handler (app_mention)
// ---------------------------------------------------------------------------

async function handleEvent(rawBody: string) {
  const body = JSON.parse(rawBody);

  // URL verification handshake
  if (body.type === "url_verification") {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge: body.challenge }),
    };
  }

  if (body.type !== "event_callback" || body.event?.type !== "app_mention") {
    return { statusCode: 200, body: "" };
  }

  // Ignore bot messages (prevent self-loops)
  if (body.event?.bot_id) {
    return { statusCode: 200, body: "" };
  }

  await ensureAgentRunning();

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: process.env.SQS_QUEUE_URL!,
      MessageBody: JSON.stringify({
        channel: body.event.channel,
        thread_ts: body.event.thread_ts ?? body.event.ts,
        event_ts: body.event.ts,
        user: body.event.user,
        text: body.event.text,
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
      taskDefinition: process.env.ECS_TASK_DEFINITION!,
      launchType: "FARGATE",
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: process.env.SUBNET_IDS!.split(","),
          securityGroups: process.env.SECURITY_GROUP_IDS!.split(","),
          assignPublicIp: "DISABLED",
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

  const adminIds = (process.env.ADMIN_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (!adminIds.includes(userId)) {
    return ephemeral("You are not authorized to use `/squirrel-admin`.");
  }

  const [subcommand, ...args] = text.split(/\s+/);

  switch (subcommand) {
    case "list":
      return handleList();
    case "add":
      return handleAdd(args, userId);
    case "remove":
      return handleRemove(args);
    case "test":
      return handleTest(args);
    default:
      return ephemeral(
        `*${AGENT_NAME} Admin Commands:*\n` +
          "• `/squirrel-admin list` — show all configured URLs\n" +
          "• `/squirrel-admin add <url> <description>` — add a URL to the allowlist\n" +
          "• `/squirrel-admin remove <url>` — remove a URL\n" +
          "• `/squirrel-admin test <url>` — preview URL content\n" +
          "• `/squirrel-admin help` — show this message"
      );
  }
}

async function handleList() {
  const items = await store.listAll();

  if (items.length === 0) {
    return ephemeral(
      "No URLs configured. Use `/squirrel-admin add <url> <description>` to add one."
    );
  }

  const lines = items.map(
    (item) =>
      `• ${item.enabled ? "✅" : "❌"} *${item.url}*\n  ${item.description} _(added by <@${item.added_by}>)_`
  );

  return ephemeral("*Configured URLs:*\n" + lines.join("\n"));
}

async function handleAdd(args: string[], userId: string) {
  if (args.length < 2) {
    return ephemeral("Usage: `/squirrel-admin add <url> <description>`");
  }

  const url = args[0];
  const description = args.slice(1).join(" ");

  if (!url.startsWith("https://")) {
    return ephemeral("URLs must start with `https://`.");
  }

  const maxUrls = parseInt(process.env.MAX_URL_COUNT ?? "100", 10);
  const currentCount = await store.count();
  if (currentCount >= maxUrls) {
    return ephemeral(`Cannot add more URLs — limit of ${maxUrls} reached.`);
  }

  await store.upsert({ url, description, added_by: userId, enabled: true });

  return ephemeral(`✅ Added: *${url}*\n${description}`);
}

async function handleRemove(args: string[]) {
  if (args.length < 1) {
    return ephemeral("Usage: `/squirrel-admin remove <url>`");
  }

  const url = args[0];
  await store.delete(url);

  return ephemeral(`✅ Removed: *${url}*`);
}

async function handleTest(args: string[]) {
  if (args.length < 1) {
    return ephemeral("Usage: `/squirrel-admin test <url>`");
  }

  const url = args[0];
  if (!url.startsWith("https://")) {
    return ephemeral("URLs must start with `https://`.");
  }

  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Squirrel-Bot/1.0" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return ephemeral(
        `❌ Fetch failed: HTTP ${response.status} ${response.statusText}`
      );
    }

    const text = await response.text();
    const preview = text.slice(0, 500).trim();
    return ephemeral(
      `✅ *${url}* is reachable (HTTP ${response.status})\n\n*Content preview:*\n\`\`\`\n${preview}\n\`\`\``
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return ephemeral(`❌ Fetch failed: ${msg}`);
  }
}

function ephemeral(text: string) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", text }),
  };
}
