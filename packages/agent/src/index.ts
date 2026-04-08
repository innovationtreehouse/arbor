import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { PostgresConfigStore, PostgresAuditStore, PostgresUrlStore } from "@arbor/db";
import { createAuditLogger } from "@arbor/logger";
import { fetchThreadHistory, postMessage, postEphemeral } from "./slack.js";
import { runAgent } from "./agent.js";
import { buildPrompt, buildSystemPrompt } from "./prompt.js";
import { BatchBuffer, type BatchEvent } from "./batch-buffer.js";
import { processAdminCommand } from "./admin.js";

export type SlackEvent = BatchEvent & { holdoff?: boolean };

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

const sqsClient = new SQSClient({ region: process.env.AWS_REGION });
const configStore = new PostgresConfigStore(DATABASE_URL);
const urlStore = new PostgresUrlStore(DATABASE_URL);
const auditStore = new PostgresAuditStore(DATABASE_URL);
const auditLogger = createAuditLogger(auditStore);
const IDLE_TIMEOUT_MS =
  parseInt(process.env.IDLE_TIMEOUT ?? "15", 10) * 60 * 1000;
const SQS_WAIT_SECONDS = 20;

export async function processEvent(event: SlackEvent): Promise<void> {
  await postEphemeral(event.channel, event.user, "_Searching…_");
  const [model, channelLimit, defaultLimit] = await Promise.all([
    configStore.get("model").catch(() => undefined),
    configStore.get(`token_limit:${event.channel}`).catch(() => undefined),
    configStore.get("token_limit:default").catch(() => undefined),
  ]);
  const rawLimit = channelLimit ?? defaultLimit;
  const maxTokens = rawLimit !== undefined && parseInt(rawLimit, 10) > 0 ? parseInt(rawLimit, 10) : undefined;
  const history = await fetchThreadHistory(event.channel, event.thread_ts);
  const prompt = buildPrompt(history, event.text);
  const systemPrompt = buildSystemPrompt();
  const start = Date.now();
  const response = await runAgent(prompt, systemPrompt, model, maxTokens);
  const duration_ms = Date.now() - start;
  await postMessage(event.channel, event.thread_ts, response);
  await auditLogger.log({
    channel: event.channel,
    thread_ts: event.thread_ts,
    user_id: event.user,
    prompt,
    response,
    model: model ?? null,
    duration_ms,
  });
}

/* v8 ignore start */
async function main(): Promise<void> {
  console.log("Arbor agent started, polling SQS...");
  let idleMs = 0;

  const batchBuffer = new BatchBuffer(60_000, async (events) => {
    for (const event of events) {
      await processEvent(event).catch((err) =>
        console.error("Batch event failed:", err)
      );
    }
  });

  while (true) {
    const result = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: process.env.SQS_QUEUE_URL!,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: SQS_WAIT_SECONDS,
      })
    );

    if (!result.Messages || result.Messages.length === 0) {
      idleMs += SQS_WAIT_SECONDS * 1000;
      if (idleMs >= IDLE_TIMEOUT_MS) {
        console.log(
          `Idle for ${IDLE_TIMEOUT_MS / 60_000}m with no messages — shutting down.`
        );
        await batchBuffer.flushAll();
        process.exit(0);
      }
      continue;
    }

    idleMs = 0;
    const sqsMessage = result.Messages[0];

    try {
      const parsed = JSON.parse(sqsMessage.Body!);
      if (parsed.type === "admin_command") {
        await processAdminCommand(parsed, { urlStore, configStore, auditStore });
      } else {
        const event: SlackEvent = parsed;
        if (event.holdoff) {
          batchBuffer.add(event);
        } else {
          await processEvent(event);
        }
      }
    } catch (err) {
      console.error("Failed to process event:", err);
    }

    await sqsClient.send(
      new DeleteMessageCommand({
        QueueUrl: process.env.SQS_QUEUE_URL!,
        ReceiptHandle: sqsMessage.ReceiptHandle!,
      })
    );
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
/* v8 ignore stop */
