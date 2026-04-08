import type { UrlStore, ConfigStore, AuditStore } from "@arbor/db";

interface AdminCommand {
  type: "admin_command";
  subcommand: string;
  args: string[];
  userId: string;
  responseUrl: string;
}

interface Stores {
  urlStore: UrlStore;
  configStore: ConfigStore;
  auditStore: AuditStore;
}

const MAX_URL_COUNT = parseInt(process.env.MAX_URL_COUNT ?? "100", 10);

export async function processAdminCommand(cmd: AdminCommand, stores: Stores): Promise<void> {
  const { subcommand, args, userId, responseUrl } = cmd;
  const { urlStore, configStore, auditStore } = stores;

  let text: string;
  try {
    switch (subcommand) {
      case "list":
        text = await handleList(urlStore);
        break;
      case "add":
        text = await handleAdd(args, userId, urlStore);
        break;
      case "remove":
        text = await handleRemove(args, urlStore);
        break;
      case "test":
        text = await handleTest(args);
        break;
      case "model":
        text = await handleModel(args, configStore);
        break;
      case "audit":
        text = await handleAudit(args, auditStore);
        break;
      case "audit-thread":
        text = await handleAuditThread(args, auditStore);
        break;
      case "token-limit":
        text = await handleTokenLimit(args, configStore);
        break;
      case "check":
        text = await handleCheck(urlStore);
        break;
      default:
        text = `Unknown subcommand: \`${subcommand}\`. Try \`/squirrel-admin help\`.`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    text = `❌ Command failed: ${msg}`;
  }

  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", text }),
    signal: AbortSignal.timeout(9_000),
  });
}

async function handleList(urlStore: UrlStore): Promise<string> {
  const items = await urlStore.listAll();
  if (items.length === 0) {
    return "No URLs configured. Use `/squirrel-admin add <url> <description>` to add one.";
  }
  const lines = items.map(
    (item) =>
      `• ${item.enabled ? "✅" : "❌"} *${item.url}*\n  ${item.description} _(added by <@${item.added_by}>)_`
  );
  return "*Configured URLs:*\n" + lines.join("\n");
}

async function handleAdd(args: string[], userId: string, urlStore: UrlStore): Promise<string> {
  if (args.length < 2) return "Usage: `/squirrel-admin add <url> <description>`";
  const url = args[0];
  const description = args.slice(1).join(" ");
  if (!url.startsWith("https://")) return "URLs must start with `https://`.";
  const currentCount = await urlStore.count();
  if (currentCount >= MAX_URL_COUNT) {
    return `Cannot add more URLs — limit of ${MAX_URL_COUNT} reached.`;
  }
  await urlStore.upsert({ url, description, added_by: userId, enabled: true });
  return `✅ Added: *${url}*\n${description}`;
}

async function handleRemove(args: string[], urlStore: UrlStore): Promise<string> {
  if (args.length < 1) return "Usage: `/squirrel-admin remove <url>`";
  await urlStore.delete(args[0]);
  return `✅ Removed: *${args[0]}*`;
}

async function handleTest(args: string[]): Promise<string> {
  if (args.length < 1) return "Usage: `/squirrel-admin test <url>`";
  const url = args[0];
  if (!url.startsWith("https://")) return "URLs must start with `https://`.";
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Squirrel-Bot/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return `❌ Fetch failed: HTTP ${response.status} ${response.statusText}`;
    }
    const text = await response.text();
    const preview = text.slice(0, 500).trim();
    return `✅ *${url}* is reachable (HTTP ${response.status})\n\n*Content preview:*\n\`\`\`\n${preview}\n\`\`\``;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `❌ Fetch failed: ${msg}`;
  }
}

async function handleModel(args: string[], configStore: ConfigStore): Promise<string> {
  if (args.length === 0) {
    const current = await configStore.get("model");
    const display = current ?? "claude-opus-4-6 (default)";
    return `*Active model:* \`${display}\``;
  }
  await configStore.set("model", args[0]);
  return `✅ Model set to \`${args[0]}\`. Takes effect on the next message.`;
}

async function handleAudit(args: string[], auditStore: AuditStore): Promise<string> {
  const limit = Math.min(parseInt(args[0] ?? "10", 10) || 10, 50);
  const records = await auditStore.listRecent(limit);
  if (records.length === 0) return "No audit records found.";
  const lines = records.map((r) => {
    const ts = new Date(r.created_at).toISOString().replace("T", " ").slice(0, 19);
    const model = r.model ?? "default";
    const summary = r.prompt.slice(0, 80).replace(/\n/g, " ");
    return `• \`${ts}\` <@${r.user_id}> in <#${r.channel}> (${r.duration_ms}ms, ${model})\n  _${summary}${r.prompt.length > 80 ? "…" : ""}_`;
  });
  return `*Recent interactions (${records.length}):*\n${lines.join("\n")}`;
}

async function handleAuditThread(args: string[], auditStore: AuditStore): Promise<string> {
  if (args.length < 2) return "Usage: `/squirrel-admin audit-thread <channel> <thread_ts>`";
  const [channel, thread_ts] = args;
  const records = await auditStore.listByThread(channel, thread_ts);
  if (records.length === 0) return "No audit records found for that thread.";
  const lines = records.map((r) => {
    const ts = new Date(r.created_at).toISOString().replace("T", " ").slice(0, 19);
    const model = r.model ?? "default";
    return `• \`${ts}\` <@${r.user_id}> (${r.duration_ms}ms, ${model})\n  *Prompt:* ${r.prompt.slice(0, 120).replace(/\n/g, " ")}${r.prompt.length > 120 ? "…" : ""}\n  *Response:* ${r.response.slice(0, 120).replace(/\n/g, " ")}${r.response.length > 120 ? "…" : ""}`;
  });
  return `*Thread interactions (${records.length}):*\n${lines.join("\n")}`;
}

async function handleTokenLimit(args: string[], configStore: ConfigStore): Promise<string> {
  const [target = "default", limitArg] = args;
  const key = target === "default" ? "token_limit:default" : `token_limit:${target}`;
  const label = target === "default" ? "default" : `<#${target}>`;
  if (limitArg !== undefined) {
    const n = parseInt(limitArg, 10);
    if (isNaN(n) || n <= 0) return "Token limit must be a positive integer.";
    await configStore.set(key, String(n));
    return `✅ Token limit for ${label} set to *${n}*.`;
  }
  const current = await configStore.get(key);
  if (current === undefined) return `No token limit set for ${label} (unlimited).`;
  return `Token limit for ${label}: *${current}* tokens per request.`;
}

async function handleCheck(urlStore: UrlStore): Promise<string> {
  const results: string[] = [];

  // Google Drive
  const googleCreds = process.env.GOOGLE_CREDENTIALS;
  if (!googleCreds) {
    results.push("❌ *Google Drive*: `GOOGLE_CREDENTIALS` not set");
  } else {
    try {
      const creds = JSON.parse(googleCreds);
      const requiredFields = ["client_email", "private_key", "project_id"];
      const missing = requiredFields.filter((f) => !creds[f]);
      if (missing.length > 0) {
        results.push(`❌ *Google Drive*: credentials JSON missing fields: ${missing.join(", ")}`);
      } else {
        // Try a lightweight Drive API call using the service account JWT
        const driveResult = await checkGoogleDrive(creds);
        results.push(driveResult);
      }
    } catch {
      results.push("❌ *Google Drive*: `GOOGLE_CREDENTIALS` is not valid JSON");
    }
  }

  // GitHub
  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    results.push("❌ *GitHub*: `GITHUB_TOKEN` not set");
  } else {
    try {
      const res = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${githubToken}`, "User-Agent": "Squirrel-Bot/1.0" },
        signal: AbortSignal.timeout(8_000),
      });
      if (res.ok) {
        const user = await res.json() as { login?: string };
        results.push(`✅ *GitHub*: authenticated as \`${user.login ?? "unknown"}\``);
      } else {
        results.push(`❌ *GitHub*: API returned HTTP ${res.status}`);
      }
    } catch (err) {
      results.push(`❌ *GitHub*: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Anthropic API key
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    results.push("❌ *Anthropic API*: `ANTHROPIC_API_KEY` not set");
  } else if (!anthropicKey.startsWith("sk-ant-")) {
    results.push("⚠️ *Anthropic API*: key set but format looks unexpected");
  } else {
    results.push(`✅ *Anthropic API*: key configured (\`${anthropicKey.slice(0, 12)}…\`)`);
  }

  // URL fetcher / database
  try {
    const count = await urlStore.count();
    results.push(`✅ *URL fetcher*: database reachable, ${count} URL${count === 1 ? "" : "s"} configured`);
  } catch (err) {
    results.push(`❌ *URL fetcher*: database error — ${err instanceof Error ? err.message : String(err)}`);
  }

  return `*Data source health check:*\n${results.join("\n")}`;
}

async function checkGoogleDrive(creds: {
  client_email: string;
  private_key: string;
  project_id: string;
}): Promise<string> {
  try {
    // Build a JWT to obtain an access token for the Drive API
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iss: creds.client_email,
      scope: "https://www.googleapis.com/auth/drive.readonly",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now,
    })).toString("base64url");

    const { createSign } = await import("crypto");
    const sign = createSign("RSA-SHA256");
    sign.update(`${header}.${payload}`);
    const signature = sign.sign(creds.private_key, "base64url");
    const jwt = `${header}.${payload}.${signature}`;

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      return `❌ *Google Drive*: auth failed (${tokenRes.status}) — ${body.slice(0, 120)}`;
    }

    const { access_token } = await tokenRes.json() as { access_token: string };

    // List up to 1 file to verify access. includeItemsFromAllDrives and
    // supportsAllDrives are required to see files in Shared Drives.
    const driveRes = await fetch(
      "https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files(id,name)&includeItemsFromAllDrives=true&supportsAllDrives=true",
      {
        headers: { Authorization: `Bearer ${access_token}` },
        signal: AbortSignal.timeout(8_000),
      }
    );

    if (!driveRes.ok) {
      return `❌ *Google Drive*: authenticated but Drive API returned HTTP ${driveRes.status}`;
    }

    const { files } = await driveRes.json() as { files: { id: string; name: string }[] };
    const fileCount = files.length;
    const note = fileCount === 0
      ? " (no files visible — share files or folders directly with the service account email)"
      : ` (${fileCount} file${fileCount === 1 ? "" : "s"} visible)`;
    return `✅ *Google Drive*: authenticated as \`${creds.client_email}\`${note}`;
  } catch (err) {
    return `❌ *Google Drive*: ${err instanceof Error ? err.message : String(err)}`;
  }
}
