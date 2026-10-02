// Test the archive users install, on its actual OS/architecture. No dependencies
// are installed inside the extracted bundle; imports must resolve from it.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const archive = process.argv[2];
if (!archive) throw new Error("Usage: node scripts/smoke-package.mjs <bundle.mcpb>");
const dir = mkdtempSync(join(tmpdir(), "iwac-installed-"));
let client;
let transport;
try {
  const cli = join(root, "node_modules/@anthropic-ai/mcpb/dist/cli/cli.js");
  execFileSync(process.execPath, [cli, "unpack", resolve(archive), dir], { stdio: "inherit" });
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert(manifest.compatibility.platforms.includes(process.platform), "Bundle must target this OS");
  // Load both external dependency trees from the isolated installed directory.
  execFileSync(process.execPath, ["--input-type=module", "-e", "await import('@google/genai'); const {DuckDBInstance}=await import('@duckdb/node-api'); const db=await DuckDBInstance.create(':memory:'); const c=await db.connect(); await c.run('SELECT 1'); c.closeSync(); db.closeSync();"], { cwd: dir, stdio: "inherit" });
  transport = new StdioClientTransport({ command: process.execPath, args: [join(dir, "server/index.js")], cwd: dir,
    stderr: "inherit", env: { ...process.env, IWAC_OFFLINE: "1", IWAC_SEMANTIC_SEARCH_ENABLED: "false",
      IWAC_CACHE_DIR: join(root, "test/fixtures"), IWAC_PRIVATE_DATASET: "false" } });
  client = new Client({ name: "installed-bundle-test", version: "1.0.0" });
  await client.connect(transport);
  const skill = await client.readResource({ uri: "skill://iwac-mcp/SKILL.md" });
  assert.equal(skill.contents[0].text, readFileSync(join(root, "../.agents/skills/iwac-mcp/SKILL.md"), "utf8"));
  const result = await client.callTool({ name: "search_articles", arguments: { country: "Bénin" } });
  assert(!result.isError, "Packaged DuckDB query must succeed");
  const data = result.structuredContent ?? JSON.parse(result.content.find((c) => c.type === "text").text);
  assert.equal(data.total_matches, 2);
  console.log(`Installed bundle passed on ${process.platform}/${process.arch}`);
} finally {
  try { await client?.close(); } finally {
    await transport?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
