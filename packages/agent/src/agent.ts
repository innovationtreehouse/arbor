import { query } from "@anthropic-ai/claude-agent-sdk";
import * as path from "path";

export async function runAgent(
  prompt: string,
  systemPrompt: string,
  model?: string
): Promise<string> {
  const maxRetries = parseInt(process.env.MAX_MCP_RETRIES ?? "2", 10);
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const base = Math.min(1000 * 2 ** (attempt - 1), 10_000);
      const delayMs = base * (1 + Math.random() * 0.1);
      console.warn(
        `[agent] attempt ${attempt} failed (${lastError?.message}), retrying in ${Math.round(delayMs)}ms`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    try {
      return await runAgentOnce(prompt, systemPrompt, model);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (!isTransientError(lastError)) throw lastError;
    }
  }

  throw lastError;
}

function isTransientError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return (
    !msg.includes("authentication_error") &&
    !msg.includes("permission_error") &&
    !msg.includes("invalid_api_key")
  );
}

async function runAgentOnce(
  prompt: string,
  systemPrompt: string,
  model?: string
): Promise<string> {
  const urlFetcherPath = path.resolve(
    __dirname,
    "../../mcp-url-fetcher/dist/index.js"
  );

  let result = "";

  for await (const message of query({
    prompt,
    options: {
      model: model ?? process.env.MODEL ?? "claude-opus-4-6",
      systemPrompt,
      mcpServers: {
        gdrive: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-gdrive"],
          env: {
            GOOGLE_CREDENTIALS: process.env.GOOGLE_CREDENTIALS!,
          },
        },
        github: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: {
            GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN!,
          },
        },
        urlFetcher: {
          command: "node",
          args: [urlFetcherPath],
          env: {
            DATABASE_URL: process.env.DATABASE_URL!,
            URL_POLL_INTERVAL_S: process.env.URL_POLL_INTERVAL_S ?? "60",
          },
        },
      },
    },
  })) {
    if ("result" in message) {
      result = message.result;
    }
  }

  return result || "I was unable to generate a response.";
}
