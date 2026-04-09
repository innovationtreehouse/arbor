#!/usr/bin/env node
/**
 * Test script: probes the google-docs-mcp MCP server locally using the
 * same logic as probeGdriveMcp() in agent.ts.
 *
 * Usage:
 *   GOOGLE_CREDENTIALS="$(cat /path/to/sa.json)" node scripts/test-gdrive-mcp.mjs
 *
 * Or with a file directly:
 *   SERVICE_ACCOUNT_PATH=/path/to/sa.json node scripts/test-gdrive-mcp.mjs
 */

import { spawnSync, execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ---------------------------------------------------------------------------
// Resolve credentials
// ---------------------------------------------------------------------------

let serviceAccountPath = process.env.SERVICE_ACCOUNT_PATH;

if (!serviceAccountPath) {
  const credJson = process.env.GOOGLE_CREDENTIALS;
  if (!credJson) {
    console.error("ERROR: set GOOGLE_CREDENTIALS or SERVICE_ACCOUNT_PATH");
    process.exit(1);
  }
  serviceAccountPath = path.join(os.tmpdir(), `sa-test-${process.pid}.json`);
  fs.writeFileSync(serviceAccountPath, credJson, { mode: 0o600 });
  console.log(`Wrote credentials to temp file: ${serviceAccountPath}`);
  process.on("exit", () => fs.rmSync(serviceAccountPath, { force: true }));
}

// ---------------------------------------------------------------------------
// Find the MCP script — container path or local global install
// ---------------------------------------------------------------------------

const CONTAINER_PATH = "/usr/local/lib/node_modules/@a-bonus/google-docs-mcp/dist/index.js";

function findMcpScript() {
  if (fs.existsSync(CONTAINER_PATH)) return CONTAINER_PATH;
  try {
    const globalRoot = execSync("npm root -g").toString().trim();
    const localPath = path.join(globalRoot, "@a-bonus/google-docs-mcp/dist/index.js");
    if (fs.existsSync(localPath)) return localPath;
  } catch {}
  return null;
}

const mcpScript = findMcpScript();
if (!mcpScript) {
  console.error("ERROR: @a-bonus/google-docs-mcp not found. Run: npm install -g @a-bonus/google-docs-mcp");
  process.exit(1);
}

const nodePath = path.dirname(path.dirname(path.dirname(mcpScript)));

console.log("MCP script:     ", mcpScript);
console.log("NODE_PATH:      ", nodePath);
console.log("Credentials:    ", serviceAccountPath);
console.log("");

// ---------------------------------------------------------------------------
// Probe: same env the MCP SDK will use + NODE_PATH
// ---------------------------------------------------------------------------

const env = {
  HOME: process.env.HOME ?? "",
  PATH: process.env.PATH ?? "",
  SERVICE_ACCOUNT_PATH: serviceAccountPath,
  NODE_PATH: nodePath,
};

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

console.log("Spawning MCP server and sending initialize...");
const result = spawnSync("node", [mcpScript], {
  input: initRequest,
  env,
  timeout: 15_000,
  encoding: "utf8",
});

console.log("\n--- exit code:", result.status, "---");

if (result.error) {
  console.error("Spawn error:", result.error.message);
  process.exit(1);
}

if (result.stderr?.trim()) {
  console.log("\n--- stderr ---");
  console.log(result.stderr.trim());
}

if (result.stdout?.trim()) {
  console.log("\n--- stdout (MCP response) ---");
  // Try to pretty-print each newline-delimited JSON message
  for (const line of result.stdout.trim().split("\n")) {
    try {
      console.log(JSON.stringify(JSON.parse(line), null, 2));
    } catch {
      console.log(line);
    }
  }
  console.log("\n✅ MCP server responded — stdio transport is working.");
} else {
  console.log("\n--- stdout: (empty) ---");
  console.log("❌ No MCP response — server exited without completing handshake.");
}
