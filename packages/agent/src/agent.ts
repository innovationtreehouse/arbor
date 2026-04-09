import { query } from "@anthropic-ai/claude-agent-sdk";
import * as path from "path";

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

  // The gdrive MCP proxy is started at container boot (docker-entrypoint.sh).
  // It spawns google-docs-mcp once, waits for auth, then exposes an HTTP server.
  // Connecting via URL is instant — no per-query cold-start or handshake timeout.
  const gdriveProxyUrl = process.env.GDRIVE_MCP_PROXY_URL;

  console.log("[agent] MCP servers:", JSON.stringify({
    gdrive: !!gdriveProxyUrl,
    github: !!process.env.GITHUB_TOKEN,
    urlFetcher: true,
  }));

  let result = "";

  for await (const message of query({
    prompt,
    options: {
      model: model ?? process.env.MODEL ?? "claude-opus-4-6",
      systemPrompt,
      allowedTools: [
        // URL fetcher — read allowed URLs
        "mcp__urlFetcher__url_fetch",
        "mcp__urlFetcher__url_list",
        // Google Drive — read only
        "mcp__gdrive__listDocuments",
        "mcp__gdrive__searchDocuments",
        "mcp__gdrive__listDriveFiles",
        "mcp__gdrive__searchDriveFiles",
        "mcp__gdrive__getDocumentInfo",
        "mcp__gdrive__listFolderContents",
        "mcp__gdrive__getFolderInfo",
        "mcp__gdrive__readDocument",
        "mcp__gdrive__downloadFile",
        // GitHub — read only
        "mcp__github__search_repositories",
        "mcp__github__search_code",
        "mcp__github__search_issues",
        "mcp__github__get_file_contents",
        "mcp__github__list_commits",
        "mcp__github__get_commit",
        "mcp__github__get_issue",
        "mcp__github__list_issues",
        "mcp__github__get_pull_request",
        "mcp__github__list_pull_requests",
        "mcp__github__get_pull_request_files",
      ],
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      mcpServers: {
        ...(gdriveProxyUrl ? {
          gdrive: {
            type: "http" as const,
            url: gdriveProxyUrl,
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

  return result || "I was unable to generate a response.";
}
