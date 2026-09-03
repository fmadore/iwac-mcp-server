// Capture the MCP App chart bundle plus real tool payloads, for screenshots.
//
// Reads `ui://iwac/charts.html` back out of the BUILT server exactly as a host
// would, then calls each UI-bearing tool against the real Hugging Face cache
// and writes the FULL CallToolResult (including the `_meta` viewData half a
// chart needs and a model never sees) next to it. A browser harness can then
// replay the MCP Apps handshake and render each chart for a screenshot.
//
//   node scripts/capture-charts.mjs <outDir>
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.argv[2] || path.join(root, "..", "tmp", "charts");
fs.mkdirSync(outDir, { recursive: true });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "server", "index.js")],
  stderr: "inherit",
  env: { ...process.env, IWAC_SEMANTIC_SEARCH_ENABLED: "false" },
});
const client = new Client({ name: "chart-capture", version: "0.0.0" });
await client.connect(transport);

const read = await client.readResource({ uri: "ui://iwac/charts.html" });
fs.writeFileSync(path.join(outDir, "charts.html"), read.contents[0]?.text ?? "");
console.log(`charts.html  ${((read.contents[0]?.text ?? "").length / 1024).toFixed(1)} kb`);

// The calls worth a slide: each shows the server describing a whole SET rather
// than returning its items.
const CALLS = [
  ["temporal", "get_temporal_distribution", { subset: "articles", granularity: "year" }],
  ["lunar", "get_temporal_distribution", { subset: "articles", granularity: "lunar_month" }],
  ["countries", "get_country_comparison", {}],
  ["collection", "get_collection_stats", {}],
  ["newspapers", "get_newspaper_stats", {}],
  ["topics", "get_topic_distribution", { subset: "articles", country: "Burkina Faso" }],
  ["field", "get_field_distribution", { subset: "articles", field: "subject", country: "Côte d'Ivoire" }],
  ["cooccurrence", "get_cooccurrence", { field: "subject", country: "Burkina Faso" }],
  ["places", "get_place_distribution", { subset: "articles" }],
  ["sentiment", "get_sentiment_distribution", { model: "all" }],
  ["lexical", "get_lexical_metrics", { subset: "articles", country: "Togo" }],
  ["periodicals", "list_periodicals", {}],
  ["semanticMap", "get_semantic_map", { subset: "articles", country: "Benin" }],
];

const manifest = [];
for (const [name, tool, args] of CALLS) {
  try {
    const res = await client.callTool({ name: tool, arguments: args });
    const payload = {
      content: res.content,
      structuredContent: res.structuredContent,
      ...(res._meta ? { _meta: res._meta } : {}),
    };
    fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(payload));
    const kb = (JSON.stringify(payload).length / 1024).toFixed(1);
    const view = res.structuredContent?.view ?? "(none)";
    console.log(`  ${name.padEnd(14)} ${tool.padEnd(28)} view=${String(view).padEnd(14)} ${kb} kb`);
    manifest.push({ name, tool, args, view });
  } catch (err) {
    console.error(`  ${name.padEnd(14)} FAILED: ${err.message}`);
  }
}
fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
await client.close();
console.log(`\nwrote ${manifest.length} payloads to ${outDir}`);
