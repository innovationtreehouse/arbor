import { query } from "@anthropic-ai/claude-agent-sdk";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawnSync } from "child_process";

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

/**
 * Spawns the google-docs-mcp process with the same env the MCP SDK will use,
 * sends a minimal JSON-RPC initialize request, and logs whether it responds.
 * This runs synchronously before query() so any crash appears in CloudWatch
 * before the agent loop starts — making silent MCP failures visible.
 */
function probeGdriveMcp(serviceAccountPath: string): void {
  const mcpScript = "/usr/local/lib/node_modules/@a-bonus/google-docs-mcp/dist/index.js";
  const env = {
    HOME: process.env.HOME ?? "",
    PATH: process.env.PATH ?? "",
    SERVICE_ACCOUNT_PATH: serviceAccountPath,
    NODE_PATH: "/usr/local/lib/node_modules",
    ...(process.env.GOOGLE_IMPERSONATE_USER
      ? { GOOGLE_IMPERSONATE_USER: process.env.GOOGLE_IMPERSONATE_USER }
      : {}),
  };

  console.log("[gdrive-probe] spawning MCP server to verify it starts...");
  console.log("[gdrive-probe] script:", mcpScript);
  console.log("[gdrive-probe] NODE_PATH:", env.NODE_PATH);
  console.log("[gdrive-probe] SERVICE_ACCOUNT_PATH:", serviceAccountPath);

  // Send a minimal MCP initialize request and wait up to 10 s for any response.
  const initRequest = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "probe", version: "0" },
    },
  }) + "\n";

  const result = spawnSync("node", [mcpScript], {
    input: initRequest,
    env,
    timeout: 10_000,
    encoding: "utf8",
  });

  if (result.error) {
    console.error("[gdrive-probe] failed to spawn process:", result.error.message);
    return;
  }

  console.log("[gdrive-probe] exit code:", result.status);

  if (result.stderr) {
    console.log("[gdrive-probe] stderr:\n" + result.stderr.trim());
  }

  if (result.stdout) {
    // Log first 500 chars — a successful initialize response starts with {"jsonrpc":"2.0"...}
    console.log("[gdrive-probe] stdout:", result.stdout.slice(0, 500).trim());
  } else {
    console.warn("[gdrive-probe] no stdout — MCP server did not respond to initialize");
  }
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
    console.log("[agent] GOOGLE_CREDENTIALS present, gdrive MCP will be started");
  } else {
    console.warn("[agent] GOOGLE_CREDENTIALS not set — gdrive MCP will not start");
  }

  console.log("[agent] MCP servers:", JSON.stringify({
    gdrive: !!serviceAccountPath,
    github: !!process.env.GITHUB_TOKEN,
    urlFetcher: true,
  }));

  if (serviceAccountPath) {
    probeGdriveMcp(serviceAccountPath);
  }

  let result = "";

  try {
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
        ...(serviceAccountPath ? {
        gdrive: {
          // Use absolute node path — the MCP SDK only inherits a minimal env
          // (HOME, PATH, SHELL, USER) when spawning subprocesses, so the short
          // binary name may not be on PATH inside ECS.
          command: "node",
          args: ["/usr/local/lib/node_modules/@a-bonus/google-docs-mcp/dist/index.js"],
          env: {
            SERVICE_ACCOUNT_PATH: serviceAccountPath,
            // NODE_PATH is required so the globally-installed package can
            // resolve its own dependencies (fastmcp, googleapis, etc.).
            // The MCP SDK only inherits a small allowlist of env vars and
            // NODE_PATH is not among them.
            NODE_PATH: "/usr/local/lib/node_modules",
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
