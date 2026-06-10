#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools/register.js";
import { config } from "./config.js";

// Injected by esbuild (scripts/bundle.mjs) from package.json — single source of
// truth for the version reported in the MCP handshake.
declare const __IWAC_VERSION__: string;
const VERSION = typeof __IWAC_VERSION__ === "string" ? __IWAC_VERSION__ : "0.0.0-dev";

async function main(): Promise<void> {
  const server = new McpServer(
    {
      name: "iwac-mcp-server",
      version: VERSION,
    },
    {
      instructions:
        "Read-only access to the Islam West Africa Collection (IWAC). " +
        "Start with get_collection_stats for an overview, then use search_articles, " +
        "search_publications, search_index, search_references, or search_documents to find records. " +
        "Use get_article / get_index_entry / get_publication_fulltext / get_reference / get_document " +
        "to drill into one item. All keyword and filter matching is accent- and case-insensitive; " +
        "country filters take exact names (Benin, Burkina Faso, Côte d'Ivoire, Niger, Nigeria, Togo). " +
        "Semantic search tools require IWAC_SEMANTIC_SEARCH_ENABLED=true and a Google API key. " +
        "\n\n" +
        "CITATIONS: every result object includes a `url` field such as " +
        "https://islam.zmo.de/s/afrique_ouest/item/28576 — always cite IWAC items " +
        "using this full URL (rendered as a markdown link), never a short form like " +
        '"art. #28576" or "item 28576". The URL is the canonical reference users need ' +
        "to open the source in the IWAC web archive.",
    },
  );

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[iwac] IWAC MCP server running on stdio (cache: ${config.cacheDir}, semantic: ${config.semanticSearchEnabled})`,
  );
}

main().catch((err) => {
  console.error("[iwac] fatal:", err);
  process.exit(1);
});
