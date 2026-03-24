import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { PostgresConfigStore, PostgresAuditStore } from "@arbor/db";
import { createAuditLogger } from "@arbor/logger";
import { fetchThreadHistory, postMessage, postEphemeral } from "./slack.js";
import { runAgent } from "./agent.js";
import { buildPrompt, buildSystemPrompt } from "./prompt.js";
import { BatchBuffer } from "./batch-buffer.js";

export interface SlackEvent {
  channel: string;
  thread_ts: string;
  event_ts: string;
  user: string;
  text: string;
  /** Set by the Lambda when the channel is in rate-limit holdoff. */
  holdoff?: boolean;
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

const sqsClient = new SQSClient({ region: process.env.AWS_REGION });
const configStore = new PostgresConfigStore(DATABASE_URL);
const auditLogger = createAuditLogger(new PostgresAuditStore(DATABASE_URL));
const IDLE_TIMEOUT_MS =
  parseInt(process.env.IDLE_TIMEOUT ?? "15", 10) * 60 * 1000;
const SQS_WAIT_SECONDS = 20;

export async function processEvent(event: SlackEvent): Promise<void> {
  await postEphemeral(event.channel, event.user, "_Searching…_");
  const model = await configStore.get("model").catch(() => undefined);
  const rawLimit = await configStore
    .get(`token_limit:${event.channel}`)
    .catch(() => undefined)
    ?? await configStore.get("token_limit:default").catch(() => undefined);
  const parsedLimit = rawLimit !== undefined ? parseInt(rawLimit, 10) : undefined;
  const maxTokens = parsedLimit !== undefined && parsedLimit > 0 ? parsedLimit : undefined;
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
      const event: SlackEvent = JSON.parse(sqsMessage.Body!);
      if (event.holdoff) {
        batchBuffer.add(event);
      } else {
        await processEvent(event);
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
