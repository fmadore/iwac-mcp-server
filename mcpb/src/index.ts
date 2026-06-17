#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools/register.js";
import { startHttpServer } from "./http.js";
import { config } from "./config.js";

// Injected by esbuild (scripts/bundle.mjs) from package.json — single source of
// truth for the version reported in the MCP handshake.
declare const __IWAC_VERSION__: string;
const VERSION = typeof __IWAC_VERSION__ === "string" ? __IWAC_VERSION__ : "0.0.0-dev";

/**
 * Guidance shipped to EVERY client in the MCP handshake. This is the ONLY
 * instruction channel a skill-less client (e.g. ChatGPT via a remote connector)
 * receives, so it carries the essential research workflow, language strategy,
 * citation rule, and caveats. Claude Desktop layers the richer `iwac-mcp` skill
 * on top of this floor.
 */
const INSTRUCTIONS =
  "The Islam West Africa Collection (IWAC) archives francophone West African newspaper " +
  "articles, Islamic publications, archival documents, audiovisual records, and academic " +
  "references on Islam and Muslim societies in Benin, Burkina Faso, Côte d'Ivoire, Niger, " +
  "Nigeria, and Togo.\n\n" +
  "WORKFLOW: call `search` with ONE concept or name at a time, then `fetch` an id from the " +
  "results to read the full text. Matching is substring-based, so 'pèlerinage' works but " +
  "'pèlerinage Mecque' as one phrase returns little — search terms separately. Beyond " +
  "search/fetch, finer tools exist (search_articles, search_publications, search_references, " +
  "search_index, search_documents, plus get_* and list_*) with country, newspaper, subject, " +
  "and date filters. All matching is accent- and case-insensitive; country filters take exact " +
  "names (Benin, Burkina Faso, Côte d'Ivoire, Niger, Nigeria, Togo).\n\n" +
  "LANGUAGE: articles and documents are in FRENCH — query in French (laïcité, confrérie, " +
  "pèlerinage). Academic references are MULTILINGUAL — search both French AND English.\n\n" +
  "CITATIONS: every result has a `url` field such as " +
  "https://islam.zmo.de/s/afrique_ouest/item/28576 — always cite IWAC items using this full " +
  'URL (rendered as a markdown link), never a short form like "art. #28576" or "item 28576".\n\n' +
  "CAVEATS: coverage is uneven across countries and periods; polarity/sentiment fields are " +
  "AI-derived, not editorial ground truth; press coverage reflects what was published, not " +
  "necessarily what happened. Semantic search tools require IWAC_SEMANTIC_SEARCH_ENABLED=true " +
  "and a Google API key (disabled on the public HTTP endpoint).";

/**
 * Build a fully-configured MCP server. Called once for stdio, and once per
 * request in stateless HTTP mode.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: "iwac-mcp-server", version: VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server);
  return server;
}

async function runStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[iwac] IWAC MCP server running on stdio (cache: ${config.cacheDir}, semantic: ${config.semanticSearchEnabled})`,
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("--http")) {
    startHttpServer(createServer);
  } else {
    await runStdio();
  }
}

main().catch((err) => {
  console.error("[iwac] fatal:", err);
  process.exit(1);
});
