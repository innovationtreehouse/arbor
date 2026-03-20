import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { PostgresConfigStore } from "@arbor/db";
import { fetchThreadHistory, postMessage, postEphemeral } from "./slack.js";
import { runAgent } from "./agent.js";
import { buildPrompt, buildSystemPrompt } from "./prompt.js";

interface SlackEvent {
  channel: string;
  thread_ts: string;
  event_ts: string;
  user: string;
  text: string;
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

const sqsClient = new SQSClient({ region: process.env.AWS_REGION });
const configStore = new PostgresConfigStore(DATABASE_URL);
const IDLE_TIMEOUT_MS =
  parseInt(process.env.IDLE_TIMEOUT ?? "15", 10) * 60 * 1000;
const SQS_WAIT_SECONDS = 20;

export async function processEvent(event: SlackEvent): Promise<void> {
  await postEphemeral(event.channel, event.user, "_Searching…_");
  const model = await configStore.get("model").catch(() => undefined);
  const history = await fetchThreadHistory(event.channel, event.thread_ts);
  const prompt = buildPrompt(history, event.text);
  const systemPrompt = buildSystemPrompt();
  const response = await runAgent(prompt, systemPrompt, model);
  await postMessage(event.channel, event.thread_ts, response);
}

/* v8 ignore start */
async function main(): Promise<void> {
  console.log("Arbor agent started, polling SQS...");
  let idleMs = 0;

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
        process.exit(0);
      }
      continue;
    }

    idleMs = 0;
    const sqsMessage = result.Messages[0];

    try {
      const event: SlackEvent = JSON.parse(sqsMessage.Body!);
      await processEvent(event);
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
