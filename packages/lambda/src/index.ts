import * as crypto from "crypto";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  ECSClient,
  ListTasksCommand,
  RunTaskCommand,
} from "@aws-sdk/client-ecs";
import { PostgresUrlStore, PostgresConfigStore, PostgresAuditStore, type UrlStore, type ConfigStore, type AuditStore } from "@arbor/db";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { ChannelRateLimiter } from "./rate-limiter.js";

const sqsClient = new SQSClient({});
const ecsClient = new ECSClient({});
const store: UrlStore = new PostgresUrlStore(process.env.DATABASE_URL!);
const configStore: ConfigStore = new PostgresConfigStore(process.env.DATABASE_URL!);
const auditStore: AuditStore = new PostgresAuditStore(process.env.DATABASE_URL!);
const rateLimiter = new ChannelRateLimiter(configStore);
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

  const channel = body.event.channel as string;
  const holdoff = await rateLimiter.recordAndCheck(channel);

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: process.env.SQS_QUEUE_URL!,
      MessageBody: JSON.stringify({
        channel,
        thread_ts: body.event.thread_ts ?? body.event.ts,
        event_ts: body.event.ts,
        user: body.event.user,
        text: body.event.text,
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
    case "model":
      return handleModel(args);
    case "audit":
      return handleAudit(args);
    case "audit-thread":
      return handleAuditThread(args);
    case "token-limit":
      return handleTokenLimit(args);
    default:
      return ephemeral(
        `*${AGENT_NAME} Admin Commands:*\n` +
          "• `/squirrel-admin list` — show all configured URLs\n" +
          "• `/squirrel-admin add <url> <description>` — add a URL to the allowlist\n" +
          "• `/squirrel-admin remove <url>` — remove a URL\n" +
          "• `/squirrel-admin test <url>` — preview URL content\n" +
          "• `/squirrel-admin model [<model-id>]` — show or set the active Claude model\n" +
          "• `/squirrel-admin audit [<limit>]` — show recent agent interactions\n" +
          "• `/squirrel-admin audit-thread <channel> <thread_ts>` — show interactions for a thread\n" +
          "• `/squirrel-admin token-limit [<channel|default> [<limit>]]` — show or set per-channel token limit\n" +
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

async function handleModel(args: string[]) {
  if (args.length === 0) {
    const current = await configStore.get("model");
    const display = current ?? `claude-sonnet-4-6 (default)`;
    return ephemeral(`*Active model:* \`${display}\``);
  }

  const model = args[0];
  await configStore.set("model", model);
  return ephemeral(`✅ Model set to \`${model}\`. Takes effect on the next message.`);
}

async function handleAudit(args: string[]) {
  const limit = Math.min(parseInt(args[0] ?? "10", 10) || 10, 50);
  const records = await auditStore.listRecent(limit);

  if (records.length === 0) {
    return ephemeral("No audit records found.");
  }

  const lines = records.map((r) => {
    const ts = new Date(r.created_at).toISOString().replace("T", " ").slice(0, 19);
    const model = r.model ?? "default";
    const summary = r.prompt.slice(0, 80).replace(/\n/g, " ");
    return `• \`${ts}\` <@${r.user_id}> in <#${r.channel}> (${r.duration_ms}ms, ${model})\n  _${summary}${r.prompt.length > 80 ? "…" : ""}_`;
  });

  return ephemeral(`*Recent interactions (${records.length}):*\n${lines.join("\n")}`);
}

async function handleAuditThread(args: string[]) {
  if (args.length < 2) {
    return ephemeral("Usage: `/squirrel-admin audit-thread <channel> <thread_ts>`");
  }

  const [channel, thread_ts] = args;
  const records = await auditStore.listByThread(channel, thread_ts);

  if (records.length === 0) {
    return ephemeral("No audit records found for that thread.");
  }

  const lines = records.map((r) => {
    const ts = new Date(r.created_at).toISOString().replace("T", " ").slice(0, 19);
    const model = r.model ?? "default";
    return `• \`${ts}\` <@${r.user_id}> (${r.duration_ms}ms, ${model})\n  *Prompt:* ${r.prompt.slice(0, 120).replace(/\n/g, " ")}${r.prompt.length > 120 ? "…" : ""}\n  *Response:* ${r.response.slice(0, 120).replace(/\n/g, " ")}${r.response.length > 120 ? "…" : ""}`;
  });

  return ephemeral(`*Thread interactions (${records.length}):*\n${lines.join("\n")}`);
}

async function handleTokenLimit(args: string[]) {
  // token-limit                      → show default
  // token-limit default              → show default
  // token-limit default <n>          → set default
  // token-limit <channel>            → show channel limit
  // token-limit <channel> <n>        → set channel limit
  const [target = "default", limitArg] = args;
  const key = target === "default" ? "token_limit:default" : `token_limit:${target}`;

  const label = target === "default" ? "default" : `<#${target}>`;

  if (limitArg !== undefined) {
    const n = parseInt(limitArg, 10);
    if (isNaN(n) || n <= 0) {
      return ephemeral("Token limit must be a positive integer.");
    }
    await configStore.set(key, String(n));
    return ephemeral(`✅ Token limit for ${label} set to *${n}*.`);
  }

  const current = await configStore.get(key);
  if (current === undefined) {
    return ephemeral(`No token limit set for ${label} (unlimited).`);
  }
  return ephemeral(`Token limit for ${label}: *${current}* tokens per request.`);
}

function ephemeral(text: string) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", text }),
  };
}
