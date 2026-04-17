#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { config } from "./config.js";

async function main(): Promise<void> {
  const server = new McpServer(
    {
      name: "iwac-mcp-server",
      version: "0.3.0",
    },
    {
      instructions:
        "Read-only access to the Islam West Africa Collection (IWAC). " +
        "Start with get_collection_stats for an overview, then use search_articles, " +
        "search_publications, search_index, or search_references to find records. " +
        "Use get_article / get_index_entry / get_publication_fulltext to drill into one item. " +
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
