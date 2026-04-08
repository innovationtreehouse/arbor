import { query } from "@anthropic-ai/claude-agent-sdk";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

export async function runAgent(
  prompt: string,
  systemPrompt: string,
  model?: string,
  maxTokens?: number,
): Promise<string> {
  const maxRetries = parseInt(process.env.MAX_MCP_RETRIES ?? "2", 10);
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const base = Math.min(1000 * 2 ** (attempt - 1), 10_000);
      const delayMs = base * (1 + Math.random() * 0.1);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      console.warn(
        `[agent] attempt ${attempt}/${maxRetries + 1} failed (${lastError?.message}), retried after ${Math.round(delayMs)}ms`
      );
    }

    try {
      return await runAgentOnce(prompt, systemPrompt, model, maxTokens);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (!isTransientError(lastError)) throw lastError;
    }
  }

  throw lastError ?? new Error("runAgent: no attempts made");
}

function isTransientError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("socket") ||
    msg.includes("network") ||
    msg.includes("overloaded") ||
    msg.includes("rate_limit") ||
    msg.includes("server_error")
  );
}

async function runAgentOnce(
  prompt: string,
  systemPrompt: string,
  model?: string,
  maxTokens?: number,
): Promise<string> {
  const urlFetcherPath = path.resolve(
    __dirname,
    "../../mcp-url-fetcher/dist/index.js"
  );

  // Write service account credentials to a temp file for the GDrive MCP server
  const credentialsJson = process.env.GOOGLE_CREDENTIALS;
  let serviceAccountPath: string | undefined;
  if (credentialsJson) {
    serviceAccountPath = path.join(os.tmpdir(), `sa-credentials-${process.pid}.json`);
    fs.writeFileSync(serviceAccountPath, credentialsJson, { mode: 0o600 });
  }

  let result = "";

  try {
  for await (const message of query({
    prompt,
    options: {
      model: model ?? process.env.MODEL ?? "claude-opus-4-6",
      systemPrompt,
      permissionMode: "bypassPermissions",
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      mcpServers: {
        ...(serviceAccountPath ? {
        gdrive: {
          command: "google-docs-mcp",
          args: [],
          env: {
            SERVICE_ACCOUNT_PATH: serviceAccountPath,
            ...(process.env.GOOGLE_IMPERSONATE_USER ? { GOOGLE_IMPERSONATE_USER: process.env.GOOGLE_IMPERSONATE_USER } : {}),
          },
        },
        } : {}),
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
  } finally {
    if (serviceAccountPath) {
      fs.rmSync(serviceAccountPath, { force: true });
    }
  }

  return result || "I was unable to generate a response.";
}
