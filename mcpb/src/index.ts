#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { registerTools } from "./tools/register.js";
import { SKILLS_CAPABILITY, servesSkills } from "./tools/skills.js";
import { registerPrompts } from "./prompts.js";
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
 * on top of this floor — this block and .agents/skills/iwac-mcp/SKILL.md
 * deliberately mirror each other, so update both together.
 * Built per-server because the semantic-search guidance
 * must match whether those tools are actually registered (they are dropped
 * entirely when IWAC_SEMANTIC_SEARCH_ENABLED is off, e.g. on the public HTTP
 * endpoint — instructions must not advertise tools that do not exist).
 */
const INSTRUCTIONS =
  "The Islam West Africa Collection (IWAC) archives francophone West African newspaper " +
  "articles, Islamic publications, archival documents, audiovisual records, fieldwork " +
  "photographs, and academic references on Islam and Muslim societies in Benin, Burkina Faso, " +
  "Côte d'Ivoire, Niger, Nigeria, and Togo.\n\n" +
  "WORKFLOW: start with `search` (a concept or name), then `fetch` an id from the results to read " +
  "the full text. The unified `search` matches each word of a multi-word query independently — " +
  "every word must appear somewhere in the item — so 'pèlerinage Mecque' narrows results rather " +
  "than failing; prefer a single concept per call. The finer search_* tools' `keyword` filter " +
  "instead does ONE literal substring match, so for those search one term at a time ('pèlerinage', " +
  "then 'Mecque'). When many items match, weigh result counts and AI abstracts before fetching full " +
  "texts. Beyond search/fetch, finer tools exist (search_articles, search_publications, " +
  "search_references, search_index, search_documents, plus get_* and list_*) with country, " +
  "newspaper, subject, and date filters — prefer the `subject` filter over keywords for curated " +
  "themes. For trends over time, call get_temporal_distribution (counts per year or month under " +
  "the same filters) instead of paging through search results. To characterise a whole set rather " +
  "than read it, the aggregate tools answer in one call what paging never will: " +
  "get_topic_distribution (how it spreads over 30 precomputed LDA topics), get_field_distribution " +
  "(rank its subjects, places, authors or languages), get_cooccurrence (what is discussed " +
  "alongside what), and get_lexical_metrics (readability, lexical richness, length). All matching is accent- and " +
  "case-insensitive; country filters take exact names (Benin, " +
  "Burkina Faso, Côte d'Ivoire, Niger, Nigeria, Togo).\n\n" +
  "ISLAMIC CALENDAR: coverage driven by observances is invisible on a Gregorian axis — the lunar year " +
  "drifts ~11 days a year, so over 1961-2025 each observance smears across all twelve Gregorian months. " +
  "For that question call get_temporal_distribution with granularity=lunar_month, which pools every year " +
  "into the twelve lunar months (Ramadan, Dhu al-Hijja/hajj and Shawwal/Korité all run well above the " +
  "even split). calendar=hijri with granularity=year|month gives a Hijri time series instead. To read the " +
  "items behind a peak, search_articles / search_publications take hijri_month (1-12, or a name in either " +
  "transliteration — Ramadan, Chaabane, Dhou al-hijja) and hijri_year. Lunar dates are precomputed with " +
  "the Umm al-Qura tables and need a full YYYY-MM-DD, so items dated only to a year or month are reported " +
  "in imprecise_date_count and are ABSENT from lunar counts, not zero. They do not exist for references " +
  "(an academic imprint date has no meaningful lunar reading).\n\n" +
  "FULL-TEXT COVERAGE: this is the public dataset, and OCR full text ships only for items whose " +
  "content is public on islam.zmo.de — about 56% of articles (7,546/13,397) and 86% of " +
  "publications (1,298/1,501). Titles and subjects are searchable for ALL items, and AI abstracts " +
  "(French AND English) for all but the newest arrivals: ingestion runs ahead of enrichment, so the " +
  "most recent ~1,050 articles carry metadata only — no OCR, abstract, sentiment or topic — and, since " +
  "rows come back newest-first, they sit on page 1. Nothing is invisible to discovery, but the " +
  "full-text half of a keyword match covers only those shares, and a triage pass on description_ai " +
  "should bound its dates rather than assume every row carries one. Call " +
  "get_collection_stats for the live `fulltext_coverage` figures, treat keyword totals as a floor " +
  "rather than a corpus-wide census, and disclose this whenever a count carries an argument.\n\n" +
  "CALL ECONOMY: hosts stop a turn after roughly 20 tool calls, and the cap counts turns of the tool " +
  "loop rather than the calls within one, so issue independent calls together in a single message rather " +
  "than one at a time. Pick the aggregate tool whose numbers answer the question instead of running the " +
  "family over the same filter. The stats and distribution tools render their own chart where the host " +
  "supports it, at no extra call: never rebuild those numbers as a separate chart or artifact, and quote " +
  "the figures in prose so the answer stands where nothing renders.\n\n" +
  "RESULTS & ERRORS: list/search tools return a pagination envelope — read `total_matches` to gauge " +
  "scale without paging, and request a sane `limit` (an over-large one is capped visibly via " +
  "`requested_limit` + `limit_warning`, never silently dropped). Enumerated filters (`country`, " +
  "`polarity`, `centrality`, `index_type`) are validated: an invalid value returns {error, " +
  "valid_values} to self-correct — an error to fix, not a finding — whereas a VALID value with 0 " +
  "rows is a real absence (there is no Nigerian press, so country='Nigeria' on search_articles is " +
  "genuinely empty). Free-text filters (newspaper, subject, author, reference_type, language) are " +
  "NOT validated, so a typo there returns 0 silently — sanity-check them. On list_locations / " +
  "list_persons, `country` means 'mentioned in records from that country' (not 'located there') and " +
  "`frequency` is a collection-wide total; the response restates this in a `note`. If `search` cannot " +
  "load a subset it still returns the rest and names the missing ones in `unavailable_categories` + " +
  "`coverage_warning` — those categories are ABSENT from the results, not empty, so retry or use their " +
  "own search_* tool before concluding a term is unattested there.\n\n" +
  "REPORT LANGUAGE: write the final report, synthesis, and follow-up questions in the language " +
  "of the user's question. If the question is mixed, use its dominant language.\n\n" +
  "QUERY LANGUAGE: formulate keyword/substr search strings and concept keywords in FRENCH for " +
  "press articles, publications, documents, and index searches, even when the " +
  "user asks in another language (laïcité, confrérie, pèlerinage, enseignement islamique). " +
  "Academic references are multilingual: search title/abstract keywords in French and English when " +
  "relevant, while keeping metadata/filter values such as reference_type and language in French. " +
  "{{SEMANTIC_QUERY_LANGUAGE}}Keep proper names and canonical filter values exact.\n\n" +
  "TRANSLITERATION: Arabic-Islamic terms appear in FRENCH transliteration — search the French " +
  "form and try variants: Tabaski or Aïd el-Kébir (not 'Eid al-Adha'); Korité or Aïd el-Fitr; " +
  "Maouloud/Mouloud (not 'Mawlid'); charia (not 'sharia'); confrérie; Wahhabisme.\n\n" +
  "RESEARCH WORKFLOW: this server also serves its own operating manual as a resource. If you do not " +
  "already have the `iwac-mcp` skill loaded, read `skill://iwac-mcp/SKILL.md` before a substantial " +
  "research task. It carries the five-phase method, French search strategy and reporting " +
  "conventions these tools assume. Its reference files (`skill://iwac-mcp/references/…`, listed in " +
  "`skill://iwac-mcp`) are meant to be read on demand, not upfront.\n\n" +
  "CITATIONS: every result has a `url` field such as " +
  "https://islam.zmo.de/s/afrique_ouest/item/28576 — always cite IWAC items using this full " +
  'URL (rendered as a markdown link), never a short form like "art. #28576" or "item 28576".\n\n' +
  "CAVEATS: coverage is uneven — Niger is thin (one newspaper, 2018 on) and Nigeria has NO press " +
  "articles (audiovisual only), so disclose this in any cross-country claim. The press is ~96% " +
  "francophone, reflecting Western-educated Muslim voices more than Arabic-trained (arabisant) " +
  "leaders. Never present results as exhaustive — absence of evidence is not evidence of absence. " +
  "Polarity/sentiment fields are AI-derived, not editorial ground truth; press coverage reflects " +
  "what was published, not necessarily what happened.{{SEMANTIC_CAVEAT}}";

/** Resolve the semantic-search placeholders against the actual tool registration. */
function buildInstructions(): string {
  return INSTRUCTIONS.replace(
    "{{SEMANTIC_QUERY_LANGUAGE}}",
    config.semanticSearchEnabled
      ? "Semantic embedding queries (`semantic_search_articles`, `semantic_search_publications`, `semantic_search_images`) may be in any language. "
      : "",
  ).replace(
    "{{SEMANTIC_CAVEAT}}",
    config.semanticSearchEnabled
      ? " The semantic_search_* tools call the Gemini embedding API at query time."
      : "",
  );
}

/**
 * How long a client may cache this server's list results (2026-07-28
 * `CacheableResult`; ignored on 2025-era connections). Every list here is fixed
 * at BUILD time — the tool, prompt and resource sets are literal registrations,
 * and the one `ui://` resource is a string baked into the bundle — so they
 * cannot change without a redeploy, which reconnects stdio hosts anyway. An
 * hour is the spec's own worked example, and caching the tool list is what
 * keeps a host's prompt cache warm across calls. `public` because nothing in
 * the lists varies per caller: the factory reads no `authInfo`, and the only
 * thing that changes the tool set (semantic search) is a process-level env var.
 */
const CACHE_HINTS = {
  "tools/list": { ttlMs: 3_600_000, cacheScope: "public" },
  "prompts/list": { ttlMs: 3_600_000, cacheScope: "public" },
  "resources/list": { ttlMs: 3_600_000, cacheScope: "public" },
  "resources/read": { ttlMs: 3_600_000, cacheScope: "public" },
  "server/discover": { ttlMs: 3_600_000, cacheScope: "public" },
} as const;

/**
 * Build a fully-configured MCP server. This is the SDK's server *factory*:
 * `serveStdio` calls it once per stdio connection, `createMcpHandler` once per
 * HTTP request. The same factory serves both protocol eras — the entry point
 * decides which era a given connection speaks, not this function.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: "iwac-mcp-server", version: VERSION },
    {
      instructions: buildInstructions(),
      cacheHints: CACHE_HINTS,
      // Draft SEP-2640, declared only when this build actually carries a skill,
      // so a host never negotiates the extension against an empty catalogue.
      // Merges with the tools/resources capabilities McpServer derives.
      ...(servesSkills() ? { capabilities: { extensions: SKILLS_CAPABILITY } } : {}),
    },
  );
  registerTools(server);
  registerPrompts(server);
  return server;
}

function runStdio(): void {
  // `serveStdio` owns the transport AND the era decision: the opening exchange
  // decides whether the connection speaks 2026-07-28 (`server/discover`, no
  // handshake) or a 2025-era `initialize`, then pins one instance from the
  // factory for the connection's lifetime. Its default `legacy: "serve"` is
  // what keeps existing hosts working — hand-wiring StdioServerTransport, as
  // this did under SDK v1, would serve the legacy era only.
  const handle = serveStdio(createServer, {
    onerror: (err) => console.error("[iwac] stdio error:", err),
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void handle.close().finally(() => process.exit(0));
    });
  }
  console.error(
    `[iwac] IWAC MCP server running on stdio (cache: ${config.cacheDir}, semantic: ${config.semanticSearchEnabled})`,
  );
}

function main(): void {
  if (process.argv.includes("--http")) {
    startHttpServer(createServer);
  } else {
    runStdio();
  }
}

try {
  main();
} catch (err) {
  console.error("[iwac] fatal:", err);
  process.exit(1);
}
