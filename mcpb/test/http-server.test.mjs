// Hermetic round-trip test for the remote Streamable-HTTP transport
// (`node server/index.js --http`) — the path the Docker/GHCR deployment runs.
// Covers what the stdio fixture test cannot: bearer-token auth, the
// refuse-to-start-without-token guard, /health, the 4 MB body cap, 404s, and a
// real MCP call through StreamableHTTPClientTransport. Uses the same synthetic
// fixtures + IWAC_OFFLINE=1, so it needs no network and runs in seconds.
//
// Run via `npm run test:http` (regenerates fixtures first). Requires a prior
// `npm run build`.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness } from "./_harness.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverJs = path.join(root, "server", "index.js");
const PORT = 18432;
const TOKEN = "test-token-fixture-http";
const BASE = `http://127.0.0.1:${PORT}`;

const baseEnv = {
  ...process.env,
  IWAC_CACHE_DIR: path.join(root, "test", "fixtures"),
  IWAC_OFFLINE: "1",
  IWAC_SEMANTIC_SEARCH_ENABLED: "false",
  PORT: String(PORT),
  // Point the token file somewhere that never exists so only the env var counts.
  IWAC_MCP_TOKEN_FILE: path.join(root, "test", "fixtures", "no-such-token-file"),
};

let failures = 0;
function fail(msg) {
  failures++;
  console.error(`  FAIL: ${msg}`);
}

// --- 1. Without a token the server must refuse to start (exit 1) --------------
{
  const env = { ...baseEnv };
  delete env.IWAC_MCP_BEARER_TOKEN;
  const child = spawn(process.execPath, [serverJs, "--http"], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise((resolve) => child.on("exit", resolve));
  if (code !== 1) fail(`tokenless --http should exit 1, exited ${code}`);
  if (!stderr.includes("bearer token")) fail(`tokenless --http should explain the missing token, got: ${stderr.slice(0, 200)}`);
}

// --- 2. Start the real server and wait for /health -----------------------------
const server = spawn(process.execPath, [serverJs, "--http"], {
  env: { ...baseEnv, IWAC_MCP_BEARER_TOKEN: TOKEN },
  stdio: ["ignore", "ignore", "inherit"],
});
try {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      up = res.status === 200 && (await res.text()) === "ok";
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!up) {
    fail("server did not become healthy within 10s");
    process.exit(1);
  }

  // --- 3. Transport-level checks (raw fetch) -----------------------------------
  const noAuth = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (noAuth.status !== 401) fail(`unauthenticated /mcp should 401, got ${noAuth.status}`);
  if (noAuth.headers.get("www-authenticate") !== "Bearer") fail("401 should carry WWW-Authenticate: Bearer");

  const badAuth = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
    body: "{}",
  });
  if (badAuth.status !== 401) fail(`wrong token should 401, got ${badAuth.status}`);

  const notFound = await fetch(`${BASE}/nope`, { method: "POST" });
  if (notFound.status !== 404) fail(`unknown path should 404, got ${notFound.status}`);

  const tooLarge = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: "x".repeat(4 * 1024 * 1024 + 1024),
  }).catch(() => null);
  // The 413 is best-effort (the server also closes the connection); accept
  // either the status or a reset, but never a 2xx.
  if (tooLarge && tooLarge.status !== 413) fail(`>4MB body should 413 (or reset), got ${tooLarge.status}`);

  // --- 4. Full MCP round-trip over Streamable HTTP ------------------------------
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  const client = new Client({ name: "http-test", version: "0.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  if (tools.tools.length !== 25) fail(`expected 25 tools over HTTP with semantic off, got ${tools.tools.length}`);

  const { call, failures: callFailures } = createHarness(client, { timeoutMs: 60_000 });
  await call("search_articles", { country: "Bénin" }, {
    check: (p) => (p.total_matches === 2 ? null : `accented Bénin over HTTP should match 2, got ${p.total_matches}`),
  });
  await call("get_collection_stats", {}, {
    structured: true,
    check: (p) => (p.subset_counts?.articles === 6 ? null : "collection stats wrong over HTTP"),
  });
  await call("search_articles", { country: "Atlantis" }, {
    expectError: true,
    checkBody: (b) => (b.includes("valid_values") ? null : "invalid country should error with valid_values over HTTP"),
  });
  failures += callFailures();

  await client.close();
  await transport.close();
} finally {
  server.kill("SIGTERM");
}

console.log(`\n${failures === 0 ? "ALL HTTP CHECKS PASSED" : `${failures} HTTP CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
