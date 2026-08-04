// Token budget gate: what this server costs a model, measured rather than guessed.
//
// Two independent budgets, because they fail in different ways:
//
//  1. ALWAYS-ON FOOTPRINT — the tool definitions and the instructions block,
//     which every client loads before the user has typed anything. It is paid
//     on every conversation whether or not a tool is ever called, it is
//     deterministic (no data, no network), and it only ever creeps upward, one
//     reasonable-looking tool at a time. Gated against a committed baseline so
//     the creep has to be argued for in a diff.
//
//  2. WORST-CASE RESPONSE — the largest answer each tool can produce when the
//     caller asks for everything it will give. Clients cap tool results
//     (Claude Code rejects anything over 25 000 tokens; Claude Desktop cuts
//     around 150 000 characters), so a tool whose worst case clears the cap is
//     not "verbose", it is broken for that caller — and it breaks on the query
//     that mattered enough to ask for 100 rows.
//
// Measured with o200k_base. That is not Claude's tokenizer — no exact one is
// published — but it is the tokenizer the public MCP token benchmarks use, it
// is within a few percent on French prose, and both gates here are about
// RELATIVE movement against a fixed yardstick rather than an absolute truth.
//
// Run via `npm run test:tokens`. Requires a prior `npm run build`.
// Pass `--update` to rewrite test/token-baseline.json after an intended change.
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = path.join(root, "test", "token-baseline.json");
const update = process.argv.includes("--update");

/**
 * Hard ceiling on the always-on footprint, in tokens.
 *
 * Reference points, all counted the same way: the archived GitHub server ran
 * 3.5k over 26 tools, Notion 17.2k over 24, Firecrawl 16.6k over 26. This
 * server is a research corpus with 34 tools and genuinely wide filter surfaces,
 * so it belongs in the middle of that range, not at the Slack end.
 *
 * The ceiling is a step-change tripwire — a second tool family landing, or an
 * outputSchema being attached to every tool — not a style guide. The drift
 * check below is what catches ordinary creep. Raising this is a decision to be
 * argued for; the number is printed on every run so growth stays visible.
 */
const FOOTPRINT_CEILING = 16_000;

/** Allowed growth over the committed baseline before a PR has to re-baseline
 * deliberately (`--update`). Deliberately cumulative: the baseline is not
 * auto-refreshed, so five 4% additions cannot pass unnoticed. */
const DRIFT_PERCENT = 5;

/**
 * Ceiling on a single tool response, in tokens.
 *
 * Sits below Claude Code's 25 000-token MCP result limit with room for the
 * client's own framing. A tool at the ceiling is not necessarily wrong — it may
 * be a caller who asked for 100 rows and meant it — but it is one schema field
 * away from being unusable, which is worth a failing build.
 */
const RESPONSE_CEILING = 20_000;

/** Larger than any server-side cap. Every numeric argument here is clamped by
 * `resolveLimit`/`capLimit` rather than rejected, so passing an absurd value is
 * how a caller asks each tool for its own maximum without this test having to
 * duplicate the per-tool caps (and drift from them). */
const BIG = 10_000;

const t = (v) => encode(typeof v === "string" ? v : JSON.stringify(v)).length;

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error(`  FAIL: ${msg}`);
};

/** Spawn the BUILT server against a fixture directory, offline. */
async function connect(name, cacheDir) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "server", "index.js")],
    stderr: "inherit",
    env: {
      ...process.env,
      IWAC_CACHE_DIR: path.join(root, "test", cacheDir),
      IWAC_OFFLINE: "1",
      IWAC_SEMANTIC_SEARCH_ENABLED: "false",
    },
  });
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(transport);
  return client;
}

// === 1. always-on footprint ==================================================

const client = await connect("token-budget", "fixtures");
const instructions = client.getInstructions?.() ?? "";
const { tools } = await client.listTools();
const { prompts } = await client.listPrompts();
const { resources } = await client.listResources();

const perTool = {};
const rows = tools
  .map((tool) => {
    perTool[tool.name] = t(tool);
    return {
      name: tool.name,
      total: t(tool),
      desc: t(tool.description ?? ""),
      input: t(tool.inputSchema ?? {}),
      output: tool.outputSchema ? t(tool.outputSchema) : 0,
    };
  })
  .sort((a, b) => b.total - a.total);

const toolTotal = rows.reduce((s, r) => s + r.total, 0);
const instructionsTokens = t(instructions);
const footprint = toolTotal + instructionsTokens;

console.log(`\ntool definitions  ${String(toolTotal).padStart(6)} tokens over ${tools.length} tools`);
console.log(`  descriptions    ${String(rows.reduce((s, r) => s + r.desc, 0)).padStart(6)}`);
console.log(`  inputSchema     ${String(rows.reduce((s, r) => s + r.input, 0)).padStart(6)}`);
console.log(`  outputSchema    ${String(rows.reduce((s, r) => s + r.output, 0)).padStart(6)}`);
console.log(`instructions      ${String(instructionsTokens).padStart(6)}`);
console.log(`prompts (${prompts.length}) + resources (${resources.length})  ${t(prompts) + t(resources)} (listed lazily by most clients — not gated)`);
console.log(`ALWAYS-ON         ${String(footprint).padStart(6)} / ${FOOTPRINT_CEILING} ceiling`);

console.log("\n  most expensive definitions:");
for (const r of rows.slice(0, 8)) {
  console.log(`    ${String(r.total).padStart(5)}  ${r.name.padEnd(28)} desc ${r.desc} · in ${r.input} · out ${r.output}`);
}

if (footprint > FOOTPRINT_CEILING) {
  fail(`always-on footprint ${footprint} tokens exceeds the ${FOOTPRINT_CEILING} ceiling`);
}

// --- drift against the committed baseline ------------------------------------
const current = { tokenizer: "o200k_base", footprint, instructions: instructionsTokens, tools: perTool };

if (update) {
  writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`\nbaseline rewritten: ${path.relative(root, baselinePath)} (${footprint} tokens)`);
} else {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const delta = footprint - baseline.footprint;
  const pct = (delta / baseline.footprint) * 100;
  console.log(`\nvs baseline       ${delta >= 0 ? "+" : ""}${delta} tokens (${pct.toFixed(1)}%)`);

  // Name the tools behind the movement — a bare percentage tells a reviewer
  // that something grew, not what to look at.
  const changed = [];
  for (const [name, cost] of Object.entries(perTool)) {
    const was = baseline.tools[name];
    if (was === undefined) changed.push(`  + ${name} (new, ${cost} tokens)`);
    else if (was !== cost) changed.push(`  ~ ${name} ${was} → ${cost}`);
  }
  for (const name of Object.keys(baseline.tools)) {
    if (perTool[name] === undefined) changed.push(`  - ${name} (removed, was ${baseline.tools[name]} tokens)`);
  }
  if (baseline.instructions !== instructionsTokens) {
    changed.push(`  ~ instructions ${baseline.instructions} → ${instructionsTokens}`);
  }
  if (changed.length) console.log(changed.join("\n"));

  if (pct > DRIFT_PERCENT) {
    fail(
      `always-on footprint grew ${pct.toFixed(1)}% over the baseline (max ${DRIFT_PERCENT}%). ` +
        `Trim it, or accept the cost with \`npm run test:tokens -- --update\` and commit the new baseline.`,
    );
  }
}

await client.close();

// === 2. worst-case responses =================================================
//
// Every registered tool must appear here, so adding a tool forces a decision
// about what its largest answer looks like — the same discipline
// checkManifestParity applies to the manifest.
//
// Ids are the stress fixtures' ids: make-stress-fixtures.mjs rewrites `o:id` as
// `base * 1000 + copy`, so fixture article 101 is 101000.
//
// A caveat worth stating rather than hiding: the aggregate tools' response size
// is driven by the CARDINALITY of the corpus (distinct months, subjects,
// places), which synthetic fixtures cannot honestly reproduce. Their numbers
// here are a floor, not a worst case. The real check on those is the same
// ceiling applied in smoke-test.mjs, which runs weekly against the live
// dataset — this gate covers the row-list and full-text tools, whose worst case
// really is a function of the server's own caps.
const WORST_CASE = {
  // Row lists: no filter (so everything matches), the largest limit the server
  // will honour, and every verbosity flag switched on.
  search: { query: "islam", limit: BIG },
  search_articles: { limit: BIG, with_description: true },
  search_by_sentiment: { limit: BIG },
  search_index: { keyword: "a", limit: BIG },
  search_publications: { keyword: "islam", limit: BIG },
  search_references: { limit: BIG },
  search_documents: { limit: BIG },
  search_audiovisual: { limit: BIG },
  search_images: { limit: BIG },
  list_subjects: { limit: BIG },
  list_locations: { limit: BIG },
  list_persons: { limit: BIG },
  list_audiovisual: { limit: BIG },
  list_periodicals: {},

  // Single items: the capped whole-text path…
  fetch: { id: "articles:101000" },
  get_article: { article_id: 101000 },
  get_publication_fulltext: { publication_id: 203000 },
  get_document: { document_id: 501000 },
  get_reference: { reference_id: 301000 },
  get_index_entry: { entry_id: 401000 },
  get_audiovisual: { audiovisual_id: 601000 },
  get_image: { image_id: 701000 },

  // …and the keyword-excerpt path at its maximum spread, which is the larger of
  // the two on any item long enough to have 25 matches.
  "get_article#excerpts": {
    tool: "get_article",
    args: { article_id: 101000, keyword: "pèlerinage", context_chars: BIG, max_excerpts: BIG },
  },
  "get_publication_fulltext#excerpts": {
    tool: "get_publication_fulltext",
    args: { publication_id: 203000, keyword: "pèlerinage", context_chars: BIG, max_excerpts: BIG },
  },
  "get_document#excerpts": {
    tool: "get_document",
    args: { document_id: 501000, keyword: "mosquée", context_chars: BIG, max_excerpts: BIG },
  },

  // Aggregates: widest grouping, largest top_n, over_time on where offered.
  get_collection_stats: {},
  get_newspaper_stats: {},
  get_country_comparison: {},
  get_sentiment_distribution: {},
  get_temporal_distribution: { subset: "articles", granularity: "month", group_by: "country" },
  get_topic_distribution: { subset: "articles", top_n: BIG, over_time: true },
  get_field_distribution: { field: "subject", subset: "articles", top_n: BIG, over_time: true },
  get_cooccurrence: { subset: "articles", top_n: BIG },
  get_place_distribution: { subset: "articles", top_n: BIG },
  get_lexical_metrics: { group_by: "newspaper", top_n: BIG },
  get_semantic_map: { subset: "articles", limit: BIG },
  get_similar_items: { id: "articles:101000", limit: BIG },
};

const stress = await connect("token-budget-stress", "fixtures-stress");
const stressTools = (await stress.listTools()).tools.map((x) => x.name);

for (const name of stressTools) {
  const covered = WORST_CASE[name] !== undefined;
  if (!covered) fail(`tool ${name} has no worst-case entry in token-budget.test.mjs WORST_CASE`);
}

console.log(`\nworst-case responses (stress fixtures, ceiling ${RESPONSE_CEILING} tokens):`);
const measured = [];
for (const [label, entry] of Object.entries(WORST_CASE)) {
  const tool = entry.tool ?? label;
  const args = entry.args ?? entry;
  if (!stressTools.includes(tool)) {
    fail(`WORST_CASE names ${tool}, which the server does not register`);
    continue;
  }
  const res = await stress.callTool({ name: tool, arguments: args }, { timeout: 60_000 });
  const body = res.content?.map((c) => c.text ?? "").join("") ?? "";
  const tokens = t(body);
  measured.push({ label, tokens });
  // An error here is a broken case, not a small response: a tool that refuses
  // its own maximum arguments would otherwise "pass" the budget at 30 tokens.
  if (res.isError === true) fail(`${label} returned an error at worst-case arguments: ${body.slice(0, 200)}`);
  if (tokens > RESPONSE_CEILING) fail(`${label} worst case is ${tokens} tokens, over the ${RESPONSE_CEILING} ceiling`);
}

measured.sort((a, b) => b.tokens - a.tokens);
for (const m of measured.slice(0, 12)) {
  console.log(`  ${String(m.tokens).padStart(6)}  ${m.label}`);
}
console.log(`  … ${measured.length - 12} more below ${measured[Math.min(12, measured.length - 1)].tokens} tokens`);

await stress.close();

if (failures > 0) {
  console.error(`\ntoken budget: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ntoken budget: OK");
