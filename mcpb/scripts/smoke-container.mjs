// Invoked against the built Docker image with synthetic parquet mounted at /cache.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const base = process.env.IWAC_SMOKE_URL ?? "http://127.0.0.1:8000";
const token = process.env.IWAC_MCP_BEARER_TOKEN;
assert(token, "Container smoke requires its test bearer token");
let ready = false;
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
    if (health.ok) { ready = true; break; }
  } catch { /* Container startup is asynchronous. */ }
  await delay(1000);
}
assert(ready, "Container did not become healthy");
assert.equal((await fetch(`${base}/mcp`, { method: "POST" })).status, 401);
const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: "container-smoke", version: "1.0.0" });
try {
  await client.connect(transport);
  const skill = await client.readResource({ uri: "skill://iwac-mcp/SKILL.md" });
  assert.equal(skill.contents[0].text, readFileSync(new URL("../../.agents/skills/iwac-mcp/SKILL.md", import.meta.url), "utf8"));
  const result = await client.callTool({ name: "search_articles", arguments: { country: "Bénin" } });
  assert(!result.isError, "Container query must load native DuckDB and fixture parquet");
  const data = result.structuredContent ?? JSON.parse(result.content.find((c) => c.type === "text").text);
  assert.equal(data.total_matches, 2);
  console.log("Container auth, embedded skill, and native SQL query passed");
} finally {
  try { await client.close(); } finally { await transport.close(); }
}
