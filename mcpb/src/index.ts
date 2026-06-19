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
  "WORKFLOW: start with `search` (a concept or name), then `fetch` an id from the results to read " +
  "the full text. The unified `search` matches each word of a multi-word query independently — " +
  "every word must appear somewhere in the item — so 'pèlerinage Mecque' narrows results rather " +
  "than failing; prefer a single concept per call. The finer search_* tools' `keyword` filter " +
  "instead does ONE literal substring match, so for those search one term at a time ('pèlerinage', " +
  "then 'Mecque'). When many items match, weigh result counts and AI abstracts before fetching full " +
  "texts. Beyond search/fetch, finer tools exist (search_articles, search_publications, " +
  "search_references, search_index, search_documents, plus get_* and list_*) with country, " +
  "newspaper, subject, and date filters — prefer the `subject` filter over keywords for curated " +
  "themes. All matching is accent- and case-insensitive; country filters take exact names (Benin, " +
  "Burkina Faso, Côte d'Ivoire, Niger, Nigeria, Togo).\n\n" +
  "RESULTS & ERRORS: list/search tools return a pagination envelope — read `total_matches` to gauge " +
  "scale without paging, and request a sane `limit` (an over-large one is capped visibly via " +
  "`requested_limit` + `limit_warning`, never silently dropped). Enumerated filters (`country`, " +
  "`polarity`, `centrality`, `index_type`) are validated: an invalid value returns {error, " +
  "valid_values} to self-correct — an error to fix, not a finding — whereas a VALID value with 0 " +
  "rows is a real absence (there is no Nigerian press, so country='Nigeria' on search_articles is " +
  "genuinely empty). Free-text filters (newspaper, subject, author, reference_type, language) are " +
  "NOT validated, so a typo there returns 0 silently — sanity-check them. On list_locations / " +
  "list_persons, `country` means 'mentioned in records from that country' (not 'located there') and " +
  "`frequency` is a collection-wide total; the response restates this in a `note`.\n\n" +
  "LANGUAGE: articles and documents are in FRENCH — query in French (laïcité, confrérie, " +
  "pèlerinage). Academic references are MULTILINGUAL — search both French AND English.\n\n" +
  "TRANSLITERATION: Arabic-Islamic terms appear in FRENCH transliteration — search the French " +
  "form and try variants: Tabaski or Aïd el-Kébir (not 'Eid al-Adha'); Korité or Aïd el-Fitr; " +
  "Maouloud/Mouloud (not 'Mawlid'); charia (not 'sharia'); confrérie; Wahhabisme.\n\n" +
  "CITATIONS: every result has a `url` field such as " +
  "https://islam.zmo.de/s/afrique_ouest/item/28576 — always cite IWAC items using this full " +
  'URL (rendered as a markdown link), never a short form like "art. #28576" or "item 28576".\n\n' +
  "CAVEATS: coverage is uneven — Niger is thin (one newspaper, 2018 on) and Nigeria has NO press " +
  "articles (audiovisual only), so disclose this in any cross-country claim. The press is ~96% " +
  "francophone, reflecting Western-educated Muslim voices more than Arabic-trained (arabisant) " +
  "leaders. Never present results as exhaustive — absence of evidence is not evidence of absence. " +
  "Polarity/sentiment fields are AI-derived, not editorial ground truth; press coverage reflects " +
  "what was published, not necessarily what happened. Semantic search tools require " +
  "IWAC_SEMANTIC_SEARCH_ENABLED=true and a Google API key (disabled on the public HTTP endpoint).";

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
