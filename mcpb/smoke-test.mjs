// Broader MCP smoke test.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["server/index.js"],
  stderr: "inherit",
});

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log(`tools (${tools.tools.length}):`, tools.tools.map((t) => t.name).join(", "));

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const body = res.content?.[0]?.text ?? "";
  const preview = body.slice(0, 500).replace(/\s+/g, " ");
  console.log(`\n[${name}] ${preview}${body.length > 500 ? "..." : ""}`);
  return body;
}

await call("search_index", { query: "Ouagadougou", limit: 2 });
await call("list_subjects", { limit: 3 });
await call("list_locations", { country: "Burkina Faso", limit: 3 });
await call("list_persons", { limit: 3 });
await call("list_audiovisual", { limit: 2 });
await call("search_references", { keyword: "Islam", limit: 2 });
await call("search_publications", { keyword: "pèlerinage", limit: 2 });
// Articles-dependent (will trigger 185 MB download on first run)
await call("get_collection_stats", {});
await call("search_articles", { country: "Burkina Faso", limit: 2 });
await call("get_newspaper_stats", { country: "Niger" });
await call("search_by_sentiment", { polarity: "Positif", limit: 2 });
await call("get_sentiment_distribution", { country: "Benin" });
await call("get_country_comparison", {});
await call("get_article", { article_id: 67613 });
await call("get_index_entry", { entry_id: 376 });
await call("get_publication_fulltext", { publication_id: 11763, keyword: "Mecque" });

await client.close();
await transport.close();
