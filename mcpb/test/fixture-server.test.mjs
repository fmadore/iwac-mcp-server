// Hermetic MCP round-trip test: spawns the BUILT server (server/index.js)
// against the synthetic fixtures (scripts/make-fixtures.mjs) with
// IWAC_OFFLINE=1 — no network, no real dataset, runs in seconds. Asserts the
// server's STRUCTURAL behavior (tool wiring, envelopes, enum errors, accent
// folding, pipe-aware filters, truncation, structuredContent parity); the live
// smoke-test.mjs remains the dataset-drift alarm.
//
// Run via `npm run test:fixture` (regenerates fixtures first). Requires a prior
// `npm run build`.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { checkManifestParity, createHarness } from "./_harness.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "server", "index.js")],
  stderr: "inherit",
  env: {
    ...process.env,
    IWAC_CACHE_DIR: path.join(root, "test", "fixtures"),
    IWAC_OFFLINE: "1",
    IWAC_SEMANTIC_SEARCH_ENABLED: "false",
  },
});

const client = new Client({ name: "fixture-test", version: "0.0.0" });
await client.connect(transport);

const { call, fail, failures } = createHarness(client, { timeoutMs: 60_000 });

// --- handshake ---------------------------------------------------------------
const instructions = client.getInstructions?.() ?? "";
if (!instructions) fail("no instructions in handshake");
if (instructions.includes("semantic_search"))
  fail("instructions mention semantic_search_* although semantic search is disabled (conditional block regressed)");
if (!instructions.includes("get_temporal_distribution"))
  fail("instructions do not mention get_temporal_distribution");

const tools = await client.listTools();
const names = tools.tools.map((t) => t.name);
if (tools.tools.length !== 25) fail(`expected 25 tools with semantic off, got ${tools.tools.length}: ${names.join(", ")}`);
if (!names.includes("get_temporal_distribution")) fail("get_temporal_distribution not registered");
for (const t of tools.tools) {
  if (!t.title && !t.annotations?.title) fail(`tool ${t.name} has no title`);
}
// Tools that promise structured output must declare an output schema.
for (const n of ["search", "fetch", "get_collection_stats", "get_temporal_distribution", "get_sentiment_distribution", "list_periodicals"]) {
  const t = tools.tools.find((x) => x.name === n);
  if (!t?.outputSchema) fail(`${n} should declare an outputSchema`);
}
// The row-heavy tools deliberately do NOT (double-encoding cost).
for (const n of ["search_articles", "get_article", "get_publication_fulltext"]) {
  const t = tools.tools.find((x) => x.name === n);
  if (t?.outputSchema) fail(`${n} should not declare an outputSchema (payload doubling)`);
}

// Manifest parity, checked hermetically on every PR (the live smoke test
// repeats this weekly): the advertised tools[] must track registration.
const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
checkManifestParity(fail, manifest, new Set(names));

// --- unified search / fetch (ChatGPT contract: both blocks) -------------------
const hits = await call("search", { query: "pèlerinage" }, {
  structured: true,
  check: (p) => {
    if (!p.results?.length) return "no results for pèlerinage";
    if (!p.results.every((r) => r.id && r.url && r.category)) return "result missing id/url/category";
    const cats = new Set(p.results.map((r) => r.category));
    if (cats.size < 2) return `expected matches across categories, got ${[...cats].join(", ")}`;
    return null;
  },
});
await call("search", { query: "pèlerinage Mecque" }, {
  structured: true,
  check: (p) => (p.results?.length ? null : "multi-word tokenized query matched nothing"),
});
await call("search", { query: "PELERINAGE" }, {
  check: (p) => (p.results?.length ? null : "unaccented uppercase query matched nothing (fold regressed)"),
});
if (hits?.results?.length) {
  await call("fetch", { id: hits.results[0].id }, {
    structured: true,
    check: (p) => {
      if (!p.text) return "fetch missing text";
      if (!p.url) return "fetch missing url";
      if (typeof p.metadata !== "object") return "fetch missing metadata object";
      return null;
    },
  });
}
// Long-OCR article: fetch must cap and point at get_article.
await call("fetch", { id: "articles:105" }, {
  structured: true,
  check: (p) => {
    if (p.text_truncated !== true) return "30k-char OCR should set text_truncated";
    if (p.recommended_tool !== "get_article") return `expected recommended_tool get_article, got ${p.recommended_tool}`;
    if (p.text.length > 26_000) return `capped text still too large: ${p.text.length}`;
    return null;
  },
});
await call("fetch", { id: "garbage" }, {
  expectError: true,
  checkBody: (b) => (b.includes("valid_categories") ? null : "malformed id should list valid_categories"),
});

// --- articles ------------------------------------------------------------------
await call("search_articles", { country: "Bénin" }, {
  check: (p) => (p.total_matches === 2 ? null : `accented Bénin should match 2 fixture articles, got ${p.total_matches}`),
});
await call("search_articles", { keyword: "pelerinage" }, {
  check: (p) => (p.total_matches >= 2 ? null : `unaccented keyword should reach accented OCR, got ${p.total_matches}`),
});
await call("search_articles", { country: "Atlantis" }, {
  expectError: true,
  checkBody: (b) => (b.includes("valid_values") ? null : "invalid country should error with valid_values"),
});
await call("search_articles", { country: "Nigeria" }, {
  check: (p) => (p.total_matches === 0 ? null : "fixture Nigeria articles should be empty (real absence)"),
});
await call("search_articles", { subject: "Mosquée", date_from: "2001", date_to: "2003" }, {
  check: (p) => (p.total_matches === 2 ? null : `pipe subject + date range expected 2, got ${p.total_matches}`),
});
await call("get_article", { article_id: 105, keyword: "pelerinage" }, {
  check: (p) => {
    if (!(p.match_count >= 100)) return `expected many matches in repeated OCR, got ${p.match_count}`;
    if (!(p.excerpts_returned <= 10)) return `excerpt cap regressed: ${p.excerpts_returned}`;
    return null;
  },
});
await call("get_article", { article_id: 99999 }, { expectError: true });

// --- references (pipe country trap) --------------------------------------------
await call("search_references", { country: "Niger" }, {
  check: (p) => (p.total_matches === 1 ? null : `Niger must match only the Niger|Nigeria row, got ${p.total_matches}`),
});
await call("search_references", { country: "Nigeria" }, {
  check: (p) => (p.total_matches === 2 ? null : `Nigeria should match pipe row + Nigeria-only row, got ${p.total_matches}`),
});
await call("search_references", { reference_type: "Livre" }, {
  check: (p) => (p.total_matches === 2 ? null : `'Livre' substring should match Livre + Chapitre de livre, got ${p.total_matches}`),
});
await call("search_references", { keyword: "sharia" }, {
  check: (p) => {
    if (p.total_matches < 1) return "English abstract keyword matched nothing";
    const long = p.results.find((r) => r.abstract_snippet?.endsWith("…"));
    return long || p.results.some((r) => r.abstract_snippet) ? null : "no abstract_snippet in results";
  },
});
await call("get_reference", { reference_id: 301 }, {
  check: (p) => (typeof p.abstract === "string" && p.abstract.length > 320 ? null : "full abstract missing on get_reference"),
});

// --- index / lists ---------------------------------------------------------------
await call("search_index", { keyword: "Dahomey" }, {
  check: (p) => (p.results?.some((r) => r.title === "Bénin") ? null : "alias Dahomey did not resolve to Bénin"),
});
await call("search_index", { keyword: "conférence", index_type: "evenements" }, {
  check: (p) => (p.total_matches === 1 ? null : `unaccented index_type should match Événements, got ${p.total_matches}`),
});
await call("search_index", { keyword: "x", index_type: "people" }, {
  expectError: true,
  checkBody: (b) => (b.includes("valid_values") ? null : "invalid index_type should list valid_values"),
});
await call("list_subjects", { limit: 500 }, {
  check: (p) => {
    if (p.limit !== 200) return `applied limit should be 200, got ${p.limit}`;
    if (p.requested_limit !== 500 || !p.limit_warning) return "visible-cap fields missing";
    return null;
  },
});
await call("list_locations", { country: "Togo" }, {
  check: (p) => {
    if (!p.results?.some((r) => r.title === "Bénin")) return "Bénin (countries Benin|Togo) should appear under Togo";
    if (!String(p.note ?? "").includes("mentioned-in")) return "mentioned-in note missing";
    return null;
  },
});
await call("list_persons", {}, {
  check: (p) => (p.results?.some((r) => r.title === "El Hadj Omar Tall") ? null : "persons list missing fixture person"),
});
await call("get_index_entry", { entry_id: 403 }, {
  check: (p) => (p.Titre === "El Hadj Omar Tall" ? null : `get_index_entry returned wrong entry: ${JSON.stringify(p).slice(0, 120)}`),
});
await call("get_index_entry", { entry_id: 99999 }, { expectError: true });

// --- stats + temporal (structured) ----------------------------------------------
await call("get_collection_stats", {}, {
  structured: true,
  check: (p) => {
    const expected = { articles: 6, publications: 3, references: 4, documents: 2, audiovisual: 2, index: 7 };
    for (const [k, v] of Object.entries(expected)) {
      if (p.subset_counts?.[k] !== v) return `subset_counts.${k} = ${p.subset_counts?.[k]}, expected ${v}`;
    }
    if (p.failed_subsets) return `unexpected failed_subsets: ${p.failed_subsets}`;
    if (p.date_range?.earliest !== "1987-03-02") return `date_range.earliest ${p.date_range?.earliest}`;
    return null;
  },
});
await call("get_newspaper_stats", { country: "Niger" }, {
  structured: true,
  check: (p) => (p.total_articles === 1 ? null : `Niger fixture count ${p.total_articles}, expected 1 (Nigeria conflation?)`),
});
await call("get_country_comparison", {}, {
  structured: true,
  check: (p) => (p.total_countries === 5 ? null : `expected 5 article countries, got ${p.total_countries}`),
});
await call("get_sentiment_distribution", { country: "Benin" }, {
  structured: true,
  check: (p) => {
    if (p.total_articles !== 2) return `Benin total ${p.total_articles}, expected 2`;
    if (p.polarity_distribution?.Négatif !== 1) return "polarity_distribution missing Négatif=1";
    return null;
  },
});
await call("search_by_sentiment", { polarity: "tres positif" }, {
  check: (p) => (p.total_matches === 1 ? null : `unaccented polarity should match 1, got ${p.total_matches}`),
});
await call("list_periodicals", {}, {
  structured: true,
  check: (p) => (p.total_periodicals === 3 ? null : `expected 3 periodicals, got ${p.total_periodicals}`),
});

// get_temporal_distribution — the new tool, thoroughly.
await call("get_temporal_distribution", {}, {
  structured: true,
  check: (p) => {
    if (p.subset !== "articles" || p.granularity !== "year") return "defaults should be articles/year";
    if (p.total_matches !== 6 || p.dated_count !== 6 || p.undated_count !== 0)
      return `counts wrong: ${JSON.stringify({ t: p.total_matches, d: p.dated_count, u: p.undated_count })}`;
    if (p.distribution?.["1995"] !== 1 || p.distribution?.["2019"] !== 1) return `distribution wrong: ${JSON.stringify(p.distribution)}`;
    const years = Object.keys(p.distribution);
    if (String(years) !== String([...years].sort())) return "years not sorted ascending";
    return null;
  },
});
await call("get_temporal_distribution", { keyword: "pèlerinage" }, {
  check: (p) => (p.dated_count === 2 && p.distribution?.["1987"] === 1 ? null : `keyword-filtered distribution wrong: ${JSON.stringify(p.distribution)}`),
});
await call("get_temporal_distribution", { group_by: "country" }, {
  check: (p) => {
    if (!p.distribution_by_group?.Benin) return "grouped distribution missing Benin";
    if (p.distribution_by_group.Benin["1995"] !== 1) return "Benin 1995 count wrong";
    if (p.distribution) return "flat distribution should be absent when grouped";
    return null;
  },
});
await call("get_temporal_distribution", { subset: "publications", granularity: "month" }, {
  check: (p) => {
    if (p.distribution?.["1912"] !== 1) return "bare-year 1912 should keep its year key at month granularity";
    if (p.distribution?.["1995-06"] !== 1) return "full date should bucket to 1995-06";
    return null;
  },
});
await call("get_temporal_distribution", { subset: "references", group_by: "country" }, {
  check: (p) =>
    p.distribution_by_group?.["Niger|Nigeria"] && String(p.note ?? "").includes("multi-valued")
      ? null
      : "pipe-joined group should surface with an explanatory note",
});
await call("get_temporal_distribution", { subset: "nonsense" }, {
  expectError: true,
  checkBody: (b) => (b.includes("valid_values") ? null : "invalid subset should list valid_values"),
});
await call("get_temporal_distribution", { subset: "references", group_by: "newspaper" }, {
  expectError: true,
  checkBody: (b) => (b.includes("not available") ? null : "newspaper group on references should error"),
});
// A supplied metadata filter whose column the subset lacks must error, not
// silently return the WHOLE subset while echoing the filter as applied.
await call("get_temporal_distribution", { subset: "references", newspaper: "Le Monde" }, {
  expectError: true,
  checkBody: (b) => (b.includes("not available") ? null : "inapplicable newspaper filter on references should error"),
});

// --- publications / documents / audiovisual --------------------------------------
await call("search_publications", { keyword: "pèlerinage" }, {
  check: (p) => {
    if (p.total_matches !== 1) return `expected 1 publication, got ${p.total_matches}`;
    if (!p.results?.[0]?.matching_toc_entries?.includes("pèlerinage")) return "matching_toc_entries missing";
    return null;
  },
});
await call("get_publication_fulltext", { publication_id: 203, keyword: "pelerinage" }, {
  check: (p) => (p.match_count >= 1 ? null : "unaccented keyword found nothing in publication OCR"),
});
await call("search_documents", {}, {
  check: (p) => (p.total_matches === 2 ? null : `expected 2 documents, got ${p.total_matches}`),
});
await call("get_document", { document_id: 501 }, {
  check: (p) => (p.ocr_text ? null : "get_document returned no OCR"),
});
await call("search_audiovisual", { language: "Haoussa" }, {
  check: (p) => (p.total_matches === 1 ? null : `Haoussa should match 1, got ${p.total_matches}`),
});
await call("search_audiovisual", { language: "Anglais" }, {
  check: (p) => (p.total_matches === 1 ? null : "pipe language Arabe|Anglais should match Anglais"),
});
await call("search_audiovisual", { medium: "VIDEO" }, {
  check: (p) => (p.total_matches === 1 ? null : `case-folded medium should match 1 video, got ${p.total_matches}`),
});
await call("search_audiovisual", { medium: "vinyl" }, {
  expectError: true,
  checkBody: (b) => (b.includes("valid_values") ? null : "invalid medium should error with valid_values"),
});
await call("list_audiovisual", {}, {
  check: (p) => (p.total_matches === 2 && p.results?.[0]?.media_url ? null : `expected 2 audiovisual items with media_url, got ${p.total_matches}`),
});
await call("get_audiovisual", { audiovisual_id: 601 }, {
  check: (p) => (p.media_url && p.medium === "audio" ? null : "get_audiovisual missing media_url/medium"),
});

// LIKE metacharacters in a keyword must match literally, not as wildcards: an
// unescaped '_' is a single-char wildcard and would match EVERY article.
await call("search_articles", { keyword: "_" }, {
  check: (p) => (p.total_matches === 0 ? null : `literal '_' should match nothing, got ${p.total_matches} (LIKE escaping regressed)`),
});

await client.close();
await transport.close();

console.log(`\n${failures() === 0 ? "ALL FIXTURE CHECKS PASSED" : `${failures()} FIXTURE CHECK(S) FAILED`}`);
process.exitCode = failures() === 0 ? 0 : 1;
