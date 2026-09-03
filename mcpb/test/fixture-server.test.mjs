// Hermetic MCP round-trip test: spawns the BUILT server (server/index.js)
// against the synthetic fixtures (scripts/make-fixtures.mjs) with
// IWAC_OFFLINE=1 — no network, no real dataset, runs in seconds. Asserts the
// server's STRUCTURAL behavior (tool wiring, envelopes, enum errors, accent
// folding, pipe-aware filters, truncation, structuredContent parity); the live
// smoke-test.mjs remains the dataset-drift alarm.
//
// Run via `npm run test:fixture` (regenerates fixtures first). Requires a prior
// `npm run build`.
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { cpSync, readFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { checkManifestParity, createHarness } from "./_harness.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let failuresFromDegraded = 0;

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

// Prompts are the only workflow channel a skill-less client (ChatGPT) gets.
const prompts = await client.listPrompts();
const promptNames = prompts.prompts.map((p) => p.name);
for (const n of ["iwac_research", "iwac_overview"]) {
  if (!promptNames.includes(n)) fail(`prompt ${n} not registered (got ${promptNames.join(", ") || "none"})`);
}
{
  const brief = await client.getPrompt({ name: "iwac_research", arguments: { question: "laïcité au Togo" } });
  const briefText = brief.messages.map((m) => m.content.text ?? "").join("\n");
  if (!briefText.includes("laïcité au Togo")) fail("iwac_research did not interpolate the question");
  if (!briefText.includes("BRIEF")) fail("iwac_research should default to brief depth");
  const ext = await client.getPrompt({
    name: "iwac_research",
    arguments: { question: "laïcité au Togo", depth: "extended" },
  });
  if (!ext.messages.map((m) => m.content.text ?? "").join("\n").includes("EXTENDED"))
    fail("iwac_research depth=extended did not select the extended workflow");
}

// MCP Apps: the ui:// chart resource must be registered and reachable. Its
// CONTENT — self-containment, size budget, every payload shape rendering, the
// interactive round trip — is test/app.test.mjs, which boots the real bundle.
{
  const resources = await client.listResources();
  const ui = resources.resources.find((r) => r.uri === "ui://iwac/charts.html");
  if (!ui) fail(`chart resource not registered (got ${resources.resources.map((r) => r.uri).join(", ") || "none"})`);
  else {
    const read = await client.readResource({ uri: ui.uri });
    if (!(read.contents[0]?.text ?? "").includes("<!DOCTYPE html>")) fail("UI resource is not an HTML document");
  }
}

const tools = await client.listTools();
const names = tools.tools.map((t) => t.name);
// Every chart-bearing tool points at the SAME resource — that is what keeps the
// suite to one copy of the SDK (docs/mcp-apps-roadmap.md §2.2).
for (const n of [
  "get_temporal_distribution",
  "get_topic_distribution",
  "get_field_distribution",
  "get_cooccurrence",
  "get_lexical_metrics",
  "get_place_distribution",
  "get_semantic_map",
  "get_similar_items",
  "get_collection_stats",
  "get_newspaper_stats",
  "get_country_comparison",
  "get_sentiment_distribution",
  "list_periodicals",
]) {
  const t = tools.tools.find((x) => x.name === n);
  if (t?._meta?.ui?.resourceUri !== "ui://iwac/charts.html")
    fail(`${n} should declare the chart UI in _meta, got ${JSON.stringify(t?._meta)}`);
}
if (tools.tools.length !== 34) fail(`expected 34 tools with semantic off, got ${tools.tools.length}: ${names.join(", ")}`);
if (!names.includes("get_temporal_distribution")) fail("get_temporal_distribution not registered");
for (const t of tools.tools) {
  if (!t.title && !t.annotations?.title) fail(`tool ${t.name} has no title`);
  if (!t.description?.trim()) fail(`tool ${t.name} has no description`);
  if (t.inputSchema?.type !== "object") fail(`tool ${t.name} must advertise an object input schema`);
  if (t.annotations?.readOnlyHint !== true) fail(`tool ${t.name} must be annotated read-only`);
  if (t.annotations?.destructiveHint !== false) fail(`tool ${t.name} must be annotated non-destructive`);
  if (t.annotations?.idempotentHint !== true) fail(`tool ${t.name} must be annotated idempotent`);
  if (t.annotations?.openWorldHint !== false) fail(`tool ${t.name} must be annotated closed-world`);
}
if (new Set(names).size !== names.length) fail("tool names must be unique");
// Tools that promise structured output must declare an output schema.
for (const n of [
  "search",
  "fetch",
  "get_collection_stats",
  "get_temporal_distribution",
  "get_sentiment_distribution",
  "list_periodicals",
  "get_topic_distribution",
  "get_field_distribution",
  "get_cooccurrence",
  "get_lexical_metrics",
  "get_place_distribution",
  "get_semantic_map",
  "get_similar_items",
]) {
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

// A query whose every token is under the 2-char floor is never RUN. Returning
// count:0 for it would be indistinguishable from a real absence, so it must be
// a self-correctable error instead.
await call("search", { query: "a" }, {
  expectError: true,
  checkBody: (b) => (b.includes("no usable search term") ? null : "sub-2-char query should be refused, not silently empty"),
});
// …whereas a real term with no matches IS a successful, empty search.
await call("search", { query: "zzzznotaterm" }, {
  structured: true,
  check: (p) => (p.count === 0 && !p.error ? null : "an unattested term should be an empty success, not an error"),
});
// Two-phase search: a term that lives only in an OCR blob still has to surface,
// which means the deep pass ran and said so.
await call("search", { query: "pédagogique" }, {
  structured: true,
  check: (p) => {
    if (!p.results?.length) return "OCR/abstract-only term found nothing (deep pass regressed)";
    if (p.deep_scan !== true) return "deep_scan should be true when the fast pass under-fills";
    return null;
  },
});
// Photographs are searchable through the unified entry point too.
await call("search", { query: "mosquée" }, {
  structured: true,
  check: (p) => (p.results?.some((r) => r.category === "images") ? null : "images subset missing from unified search"),
});
// Audiovisual items have no descriptionAI at all (0/1,771 in the real subset);
// the transcription is their only text, so fetch must return it as `text`.
await call("fetch", { id: "audiovisual:601" }, {
  structured: true,
  check: (p) => {
    if (!p.text?.includes("Tafsirin")) return `audiovisual fetch should return the transcription, got: ${String(p.text).slice(0, 60)}`;
    if (!p.url) return "audiovisual fetch missing url";
    return null;
  },
});

// --- articles ------------------------------------------------------------------
await call("search_articles", { country: "Bénin" }, {
  check: (p) => (p.total_matches === 2 ? null : `accented Bénin should match 2 fixture articles, got ${p.total_matches}`),
});
await call("search_articles", { keyword: "pelerinage" }, {
  check: (p) => (p.total_matches >= 2 ? null : `unaccented keyword should reach accented OCR, got ${p.total_matches}`),
});
// The English half of the bilingual AI summary must be searchable. "pilgrimage"
// appears ONLY in `descriptionAI_en` — nowhere in a title, a French summary or
// the OCR — so a hit here can only have come through the English column. If the
// dataset splits `descriptionAI` by language and the server forgets to mark the
// English side searchable, English queries silently stop matching summaries,
// which is worse for anglophone discovery than the pipe-joined column was.
await call("search_articles", { keyword: "pilgrimage" }, {
  check: (p) => (p.total_matches === 1 && String(p.results?.[0]?.id) === "101"
    ? null
    : `English-only summary term should find article 101, got ${p.total_matches}`),
});
// …and through the unified `search`, whose cheap first pass is FAST_TEXT_COLS.
await call("search", { query: "pilgrimage" }, {
  structured: true,
  check: (p) => (p.results?.some((r) => String(r.id).endsWith("101"))
    ? null
    : "unified search should reach the English summary on the fast pass"),
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
// A limit under the floor is clamped to 1 — say so, exactly as an over-large
// one is. Silently returning a single row reads as "that is all there is".
await call("search_articles", { limit: 0 }, {
  check: (p) => {
    if (p.limit !== 1) return `limit 0 should clamp to 1, got ${p.limit}`;
    if (p.requested_limit !== 0 || !String(p.limit_warning ?? "").includes("below the minimum"))
      return "low-end clamp must surface requested_limit + limit_warning";
    return null;
  },
});
// Same rule for the excerpt caps.
await call("get_article", { article_id: 105, keyword: "pelerinage", max_excerpts: -3 }, {
  check: (p) =>
    p.excerpts_returned === 1 && String(p.parameter_note ?? "").includes("max_excerpts")
      ? null
      : "clamped max_excerpts should be reported in parameter_note",
});

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
// `with_description` lowers this tool's own maximum, because 100 rows carrying a
// ~500-char abstract each is ~27k tokens — past the ceiling Claude Code applies
// to a tool result, so the caller receives nothing at all. The clamp has to be
// visible for the same reason every other clamp here is.
await call("search_articles", { limit: 100, with_description: true }, {
  check: (p) => {
    if (p.limit !== 25) return `with_description should cap the limit at 25, got ${p.limit}`;
    if (p.requested_limit !== 100) return "visible-cap fields missing on the with_description cap";
    if (!String(p.limit_warning ?? "").includes("with_description"))
      return "limit_warning should name with_description as the reason";
    return null;
  },
});
await call("search_articles", { limit: 100 }, {
  check: (p) => (p.limit === 100 ? null : `without with_description the limit should stay 100, got ${p.limit}`),
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
    const expected = { articles: 6, publications: 3, references: 4, documents: 2, audiovisual: 3, images: 3, index: 7 };
    for (const [k, v] of Object.entries(expected)) {
      if (p.subset_counts?.[k] !== v) return `subset_counts.${k} = ${p.subset_counts?.[k]}, expected ${v}`;
    }
    if (p.failed_subsets) return `unexpected failed_subsets: ${p.failed_subsets}`;
    if (p.date_range?.earliest !== "1987-03-02") return `date_range.earliest ${p.date_range?.earliest}`;
    // The public dataset masks full text per row; a keyword count is a floor,
    // not a census, and the stats tool is where that gets stated.
    const cov = p.fulltext_coverage?.articles;
    if (!cov) return "fulltext_coverage missing for articles";
    if (cov.with_fulltext !== 5 || cov.total !== 6) return `articles coverage ${JSON.stringify(cov)}, expected 5/6`;
    if (!String(p.fulltext_note ?? "").includes("public")) return "fulltext_note missing";
    if (p.fulltext_coverage.index) return "index has no OCR column and must not claim coverage";
    return null;
  },
});
await call("get_newspaper_stats", { country: "Niger" }, {
  structured: true,
  check: (p) => (p.total_articles === 1 ? null : `Niger fixture count ${p.total_articles}, expected 1 (Nigeria conflation?)`),
});
await call("get_country_comparison", {}, {
  structured: true,
  check: (p) => {
    if (p.total_countries !== 5) return `expected 5 article countries, got ${p.total_countries}`;
    // The polarity buckets are one model's, so the payload has to say whose.
    if (p.polarity_model !== "gpt-5-6-luna") return `polarity_model wrong: ${p.polarity_model}`;
    if (!p.countries?.some((c) => c.polarity && Object.keys(c.polarity).length)) return "no country carries polarity";
    return null;
  },
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
// Subjectivity became filterable when generation 2 turned it from a 1-5 float
// into a closed label vocabulary. Same accent-folding contract as the other two.
await call("search_by_sentiment", { subjectivity: "plutot objectif" }, {
  check: (p) =>
    p.total_matches === 3 ? null : `unaccented subjectivity should match 3, got ${p.total_matches}`,
});
// Narrower than either filter alone (3 ∩ 3 = 2), so a dropped clause shows up
// as a count that is too high rather than as a plausible-looking zero.
await call("search_by_sentiment", { subjectivity: "Plutôt objectif", polarity: "Neutre" }, {
  check: (p) =>
    p.total_matches === 2 ? null : `subjectivity AND polarity should match 2, got ${p.total_matches}`,
});
await call("search_by_sentiment", { subjectivity: "3" }, {
  expectError: true,
  checkBody: (b) =>
    b.includes("valid_values") && b.includes("Très objectif")
      ? null
      : "a generation-1 numeric rating should error with the label vocabulary, not silently match nothing",
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

// --- the Hijri calendar ----------------------------------------------------------
// The lunar columns are precomputed by the pipeline
// (post-processing/calculate_hijri_dates.py); the fixtures carry the same
// hijridate values the pipeline would write. The six fixture articles fall in
// Muharram, Jumada II, Rajab, Ramadan and Dhu al-Qa'da (×2).
await call("get_temporal_distribution", { granularity: "lunar_month" }, {
  structured: true,
  check: (p) => {
    // lunar_month implies the Hijri calendar; the caller should not have to say so twice.
    if (p.calendar !== "hijri") return `lunar_month should imply calendar=hijri, got ${p.calendar}`;
    if (p.view !== "lunar") return `lunar_month should tag the lunar view, got ${p.view}`;
    const d = p.distribution ?? {};
    if (d["11"] !== 2) return `Dhu al-Qa'da should hold 2 articles, got ${JSON.stringify(d)}`;
    if (d["09"] !== 1 || d["01"] !== 1 || d["06"] !== 1 || d["07"] !== 1)
      return `lunar distribution wrong: ${JSON.stringify(d)}`;
    if (Object.keys(d).length !== 5) return `expected 5 occupied months, got ${JSON.stringify(d)}`;
    // Keys are zero-padded so they sort; names ride along so the model and the
    // chart never hard-code a transliteration.
    if (p.month_labels?.["09"] !== "Ramadan") return `month_labels wrong: ${JSON.stringify(p.month_labels)}`;
    // The two key sets are a CONTRACT, not a coincidence: the chart looks each
    // bucket up in month_labels, so a bucket key that misses is not an error
    // anywhere — it is a bar that silently never draws. Assert the label set is
    // exactly the twelve canonical keys, and that every bucket is one of them.
    // (Shipped once as '3.' — DOUBLE columns cast straight to VARCHAR — which
    // dropped nine of twelve months from the lunar chart without failing a
    // single test.)
    const canonical = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));
    const labelKeys = Object.keys(p.month_labels ?? {}).sort();
    if (labelKeys.length !== 12 || labelKeys.some((k, i) => k !== canonical[i]))
      return `month_labels keys must be exactly 01..12, got ${JSON.stringify(labelKeys)}`;
    const strays = Object.keys(d).filter((k) => !(k in (p.month_labels ?? {})));
    if (strays.length) return `lunar buckets absent from month_labels (they would not render): ${JSON.stringify(strays)}`;
    if (!String(p.note ?? "").includes("pooled across all Hijri years"))
      return "lunar_month must disclose that it pools years and is not seasonality";
    return null;
  },
});
await call("get_temporal_distribution", { calendar: "hijri", granularity: "year" }, {
  structured: true,
  check: (p) => {
    if (p.view !== "temporal") return "hijri YEARS are still a time series, so still the temporal view";
    if (p.distribution?.["1440"] !== 1 || p.distribution?.["1407"] !== 1)
      return `hijri year distribution wrong: ${JSON.stringify(p.distribution)}`;
    return null;
  },
});
await call("get_temporal_distribution", { calendar: "hijri", granularity: "month" }, {
  check: (p) =>
    p.distribution?.["1440-09"] === 1 ? null : `hijri year-month bucket wrong: ${JSON.stringify(p.distribution)}`,
});
// An imprecise date has no lunar month. It must be reported as excluded, never
// folded into undated_count (which means "no date at all") and never plotted.
await call("get_temporal_distribution", { subset: "publications", granularity: "lunar_month" }, {
  structured: true,
  check: (p) => {
    if (p.total_matches !== 3) return `publications total wrong: ${p.total_matches}`;
    if (p.dated_count !== 1) return `only the fully-dated issue converts, got ${p.dated_count}`;
    if (p.imprecise_date_count !== 2)
      return `the two year-only issues should be imprecise_date_count, got ${p.imprecise_date_count}`;
    if (p.undated_count !== 0) return `no issue is truly undated, got ${p.undated_count}`;
    if (!String(p.note ?? "").includes("too imprecise")) return "the imprecise exclusion must be disclosed";
    return null;
  },
});
// references deliberately has no lunar columns (an academic imprint date has no
// meaningful lunar reading), so asking must be a self-correctable error.
await call("get_temporal_distribution", { subset: "references", calendar: "hijri" }, {
  expectError: true,
  checkBody: (b) =>
    b.includes("no Hijri date columns") && b.includes("not references")
      ? null
      : "hijri on references should error and name the subsets that do carry lunar dates",
});
await call("get_temporal_distribution", { granularity: "lunar_month", calendar: "gregorian" }, {
  expectError: true,
  checkBody: (b) => (b.includes("Hijri bucket") ? null : "lunar_month + calendar=gregorian is incoherent and must error"),
});
await call("get_temporal_distribution", { calendar: "julian" }, {
  expectError: true,
  checkBody: (b) => (b.includes("valid_values") ? null : "invalid calendar should list valid_values"),
});

// The lunar filters on the search tools — what turns a peak into readable items.
await call("search_articles", { hijri_month: "Ramadan" }, {
  check: (p) => {
    if (p.total_matches !== 1)
      return `hijri_month=Ramadan should find 1 article, got ${p.total_matches}`;
    const row = p.results?.[0];
    if (row?.date !== "2019-05-20") return `expected the 2019 Niger article, got ${row?.date}`;
    // Filtering by a calendar has to show that calendar, or the caller cannot
    // see what matched.
    if (row?.hijri_date !== "1440-09-15") return `row should carry its lunar date, got ${row?.hijri_date}`;
    return null;
  },
});
await call("search_articles", { hijri_month: "9" }, {
  check: (p) => (p.total_matches === 1 ? null : `the month number should behave like its name, got ${p.total_matches}`),
});
await call("search_articles", { hijri_month: "Dhou al-hijja" }, {
  check: (p) => (p.total_matches === 0 ? null : `no fixture article falls in Dhu al-Hijja, got ${p.total_matches}`),
});
await call("search_articles", { hijri_month: "11" }, {
  check: (p) => (p.total_matches === 2 ? null : `Dhu al-Qa'da should hold 2 articles, got ${p.total_matches}`),
});
await call("search_articles", { hijri_year: 1440 }, {
  check: (p) => (p.total_matches === 1 ? null : `hijri_year=1440 should find 1 article, got ${p.total_matches}`),
});
await call("search_articles", { hijri_month: "Ramadam" }, {
  expectError: true,
  checkBody: (b) =>
    b.includes("valid_values") && b.includes("Ramadan")
      ? null
      : "a misspelt lunar month must error with valid_values, not return an empty result",
});
await call("search_publications", { hijri_month: "Mouharram" }, {
  check: (p) => (p.total_matches === 1 ? null : `French month name on publications, got ${p.total_matches}`),
});

// --- corpus aggregates -----------------------------------------------------------
await call("get_topic_distribution", {}, {
  structured: true,
  check: (p) => {
    if (p.total_matches !== 6 || p.classified !== 6) return `topic counts wrong: ${p.total_matches}/${p.classified}`;
    const top = p.topics?.[0];
    if (top?.count !== 2) return `expected a 2-article leading topic, got ${JSON.stringify(top)}`;
    if (!p.topics.every((t) => t.label && typeof t.avg_prob === "number")) return "topic rows missing label/avg_prob";
    // Descending by count is what every consumer assumes.
    const counts = p.topics.map((t) => t.count);
    if (String(counts) !== String([...counts].sort((a, b) => b - a))) return "topics not ordered by count";
    return null;
  },
});
// over_time splits its answer: the model gets each band's SHAPE, the chart gets
// the per-year matrix through `_meta` (src/viewContract.ts). Both halves are
// checked here, because a split that dropped the series on the floor would otherwise
// look like a pass, since the model half alone still parses.
await call("get_topic_distribution", { over_time: true, top_n: 1 }, {
  check: (p, _body, res) => {
    if (p.periods || p.series_by_topic) return "the raw per-year series must not be in the model's half";
    if (!p.span?.length) return "over_time returned no span";
    const trend = p.trend_by_topic ?? {};
    if (!Object.keys(trend).length) return "over_time returned no per-topic trend summary";
    for (const [label, t] of Object.entries(trend)) {
      if (!t.peak_year || !t.first || !t.last) return `trend for '${label}' is missing first/last/peak`;
      if (t.first > t.peak_year || t.peak_year > t.last) return `trend for '${label}' has peak outside [first,last]`;
      if (t.median_year < t.first || t.median_year > t.last) return `trend for '${label}' has median outside its span`;
    }

    const view = res._meta?.["islam.zmo.de/viewData"];
    if (!view) return "no view data in _meta, so the chart would have nothing to plot";
    if (!view.periods?.length) return "view half carries no periods";
    const bands = Object.keys(view.series_by_topic ?? {});
    if (!bands.includes("(other topics)")) return `top_n=1 should fold the rest into one band, got ${bands}`;
    // The bands must still total the classified count, or the area chart lies.
    const summed = bands.reduce((a, b) => a + Object.values(view.series_by_topic[b]).reduce((x, y) => x + y, 0), 0);
    if (summed !== p.classified) return `bands sum to ${summed}, classified is ${p.classified}`;
    // The summary must describe the series it replaced, not drift from it.
    for (const [label, t] of Object.entries(trend)) {
      const byYear = view.series_by_topic[label];
      if (!byYear) return `trend summarises '${label}', absent from the series`;
      const realTotal = Object.values(byYear).reduce((a, b) => a + b, 0);
      if (t.total !== realTotal) return `trend total for '${label}' is ${t.total}, series sums to ${realTotal}`;
      if (byYear[t.peak_year] !== t.peak_count) return `trend peak for '${label}' does not match the series`;
    }
    return null;
  },
});
// min_prob must exclude, and say what it excluded.
await call("get_topic_distribution", { min_prob: 0.5 }, {
  check: (p) =>
    p.classified < 6 && String(p.note ?? "").includes("min_prob")
      ? null
      : `min_prob should shrink the set and disclose it: ${p.classified} / ${p.note}`,
});

await call("get_field_distribution", { field: "subject" }, {
  structured: true,
  check: (p) => {
    if (p.items_with_value !== 6) return `expected 6 subject-tagged articles, got ${p.items_with_value}`;
    // Pipe-split: 'Pèlerinage|Religion' must count once for each half.
    const ramadan = p.values?.find((v) => v.value === "Ramadan");
    if (ramadan?.count !== 2) return `Ramadan should appear twice, got ${JSON.stringify(ramadan)}`;
    if (!String(p.note ?? "").includes("multi-valued")) return "multi-valued fields must disclose double counting";
    return null;
  },
});
await call("get_field_distribution", { field: "author", over_time: true }, {
  check: (p) => {
    if (p.items_with_value !== 4) return `4 of 6 fixture articles are signed, got ${p.items_with_value}`;
    if (!p.coverage_by_year?.["1995"]) return "over_time returned no per-year coverage";
    const y = p.coverage_by_year["1995"];
    if (y.total !== 1 || y.with_value !== 1) return `1995 coverage wrong: ${JSON.stringify(y)}`;
    return null;
  },
});
await call("get_field_distribution", { field: "OCR" }, {
  expectError: true,
  checkBody: (b) => (b.includes("valid_values") ? null : "a non-rankable field should list the valid ones"),
});
await call("get_field_distribution", { field: "spatial", top_n: 1 }, {
  check: (p) =>
    p.values?.length === 1 && p.other_values > 0
      ? null
      : `top_n must cap AND report the remainder: ${JSON.stringify(p.values)} / ${p.other_values}`,
});

await call("get_cooccurrence", { field: "subject", top_n: 3 }, {
  structured: true,
  check: (p) => {
    if (p.values?.length !== 3) return `expected 3 axis values, got ${p.values?.length}`;
    const m = p.matrix;
    if (m.length !== 3 || m.some((r) => r.length !== 3)) return "matrix is not square";
    // Symmetric, with each value's own count on the diagonal.
    for (let i = 0; i < 3; i++) {
      if (m[i][i] !== p.values[i].count) return `diagonal ${i} should be the value's own count`;
      for (let j = 0; j < 3; j++) if (m[i][j] !== m[j][i]) return `matrix not symmetric at ${i},${j}`;
    }
    if (p.top_pairs?.some((x) => x.a === x.b)) return "top_pairs should not contain self-pairs";
    return null;
  },
});

// The point cloud is chart-only data: a 2-D PCA coordinate is an artefact of
// this projection, not a fact the model can reason from, so it travels in
// `_meta` and the model gets per-group counts instead.
await call("get_semantic_map", { color_by: "country" }, {
  structured: true,
  check: (p, _body, res) => {
    if (p.projected !== 6) return `expected all 6 fixture articles projected, got ${p.projected}`;
    if (p.points) return "coordinates must not be in the model's half";
    const points = res._meta?.["islam.zmo.de/viewData"]?.points;
    if (!points?.length) return "no points in _meta, so the chart would render an empty scatter";
    if (points.length !== p.projected) return `_meta has ${points.length} points, projected says ${p.projected}`;
    if (!points.every((x) => Number.isFinite(x.x) && Number.isFinite(x.y))) return "a point has no finite coordinates";
    if (!points.every((x) => x.group)) return "color_by=country did not populate group";
    // The group counts the model is given must describe the cloud it replaced.
    const tally = {};
    for (const x of points) tally[x.group] = (tally[x.group] ?? 0) + 1;
    if (JSON.stringify(p.groups) !== JSON.stringify(tally)) {
      return `groups ${JSON.stringify(p.groups)} does not match the plotted points ${JSON.stringify(tally)}`;
    }
    const [a, b] = p.explained_variance ?? [];
    if (!(a > 0 && b >= 0 && a + b <= 1.0001)) return `explained_variance ${p.explained_variance} is not a share`;
    if (a < b) return "components should be ordered by variance";
    // The fixture embeddings are two separable clusters, so a 2-d projection
    // should capture nearly all of the variance.
    if (a + b < 0.9) return `two clusters in 4-d should project cleanly, got ${a + b}`;
    if (!String(p.note ?? "").includes("NOT the UMAP")) return "must disclaim the UMAP comparison";
    return null;
  },
});
// `polarity` is the stable public name for a column whose real name carries the
// model; the current dataset spelling resolves onto it too.
for (const value of ["polarity", "gpt_5_6_luna_polarite"]) {
  await call("get_semantic_map", { color_by: value }, {
    structured: true,
    check: (p, _body, res) => {
      if (p.color_by !== "polarity") return `color_by=${value} should echo "polarity", got ${p.color_by}`;
      const points = res._meta?.["islam.zmo.de/viewData"]?.points;
      if (!points?.every((x) => x.group)) return `color_by=${value} did not populate group`;
      return null;
    },
  });
}
// A generation-1 column name must NOT alias onto `polarity`: it holds a
// different model's reading, so colouring by it while the legend says
// gpt-5-6-luna would be a chart that lies.
await call("get_semantic_map", { color_by: "gemini_3_flash_preview_polarite" }, {
  expectError: true,
  checkBody: (b) => (b.includes("valid_values") ? null : "a generation-1 colour column should be refused with valid_values"),
});
// Deterministic: the same filter must project the same picture, or the chart
// reshuffles itself on every call and cannot be read as evidence.
{
  const one = await call("get_semantic_map", {}, {});
  const two = await call("get_semantic_map", {}, {});
  if (JSON.stringify(one?.points) !== JSON.stringify(two?.points))
    fail("get_semantic_map is not deterministic across calls");
}
await call("get_semantic_map", { color_by: "OCR" }, {
  expectError: true,
  checkBody: (b) => (b.includes("valid_values") ? null : "an invalid color_by should list the valid ones"),
});

await call("get_similar_items", { id: "101", limit: 3 }, {
  structured: true,
  check: (p) => {
    if (p.source?.id !== "101") return "source not echoed";
    if (p.neighbours?.length !== 3) return `expected 3 neighbours, got ${p.neighbours?.length}`;
    if (p.neighbours.some((n) => n.id === "101")) return "the source must not be its own neighbour";
    // Descending, and 105 (the other pilgrimage vector) must lead.
    const scores = p.neighbours.map((n) => n.score);
    if (String(scores) !== String([...scores].sort((a, b) => b - a))) return "neighbours not sorted by score";
    if (p.neighbours[0].id !== "105") return `nearest to 101 should be 105, got ${p.neighbours[0].id}`;
    if (!p.neighbours.every((n) => n.url?.startsWith("https://"))) return "neighbours need a resolvable url";
    return null;
  },
});
await call("get_similar_items", { id: "101", min_score: 0.999 }, {
  check: (p) => (p.neighbours?.length === 0 ? null : "min_score should be able to exclude everything"),
});
await call("get_similar_items", { id: "does-not-exist" }, {
  expectError: true,
  checkBody: (b) => (b.includes("No articles item") ? null : `unknown id should say so: ${b.slice(0, 120)}`),
});

// --- id shapes: `search`/`fetch` speak `<subset>:<o:id>`, so this must too ----
await call("get_similar_items", { id: "articles:101", limit: 3 }, {
  structured: true,
  check: (p) => {
    if (p.source?.id !== "101") return "a namespaced id should resolve to the bare o:id";
    if (p.neighbours?.[0]?.id !== "105") return "namespaced id must give the same neighbours as the bare one";
    return null;
  },
});
await call("get_similar_items", { id: "articles:101", subset: "articles" }, {
  structured: true,
  check: (p) => (p.source?.id === "101" ? null : "an id whose prefix AGREES with subset is not a conflict"),
});
await call("get_similar_items", { id: "references:301", subset: "articles" }, {
  expectError: true,
  checkBody: (b) =>
    b.includes("names subset") ? null : `a prefix contradicting subset should say so: ${b.slice(0, 140)}`,
});
await call("get_similar_items", { id: "index:900" }, {
  expectError: true,
  checkBody: (b) => (b.includes("valid_values") ? null : `an unsupported id prefix should list valid subsets: ${b.slice(0, 140)}`),
});

// --- bad date bounds are rejected, never silently dropped --------------------
// The regression this guards: an unparseable bound used to be discarded, so the
// query widened to the WHOLE corpus while `filters` still echoed the bad value.
const fullCorpus = (await call("get_field_distribution", { field: "subject" }, { structured: true }))?.total_matches;
for (const [tool, args] of [
  ["get_field_distribution", { field: "subject", date_from: "not-a-date" }],
  ["get_field_distribution", { field: "subject", date_to: "yesterday" }],
  ["get_field_distribution", { field: "subject", date_from: "2001-13-01" }],
  ["get_topic_distribution", { date_from: "n/a" }],
  ["get_cooccurrence", { date_from: "n/a" }],
  ["get_place_distribution", { date_from: "n/a" }],
  ["get_semantic_map", { date_from: "n/a" }],
  ["get_lexical_metrics", { date_from: "n/a" }],
  // the same helper backs every date-filtering tool, not just the aggregates
  ["search_articles", { date_from: "not-a-date" }],
  ["search_references", { date_to: "circa 1990" }],
  ["search_publications", { date_from: "?" }],
  ["get_temporal_distribution", { date_from: "not-a-date" }],
]) {
  await call(tool, args, {
    expectError: true,
    checkBody: (b) =>
      b.includes("valid_format") ? null : `${tool} should reject a bad date bound, not drop it: ${b.slice(0, 160)}`,
  });
}
// ...while every documented shape still parses
for (const args of [{ date_from: "2001" }, { date_from: "2001-06" }, { date_from: "2001-06-15" }, { date_from: "2001-06-15T09:30:00Z" }]) {
  await call("get_field_distribution", { field: "subject", ...args }, {
    structured: true,
    check: (p) => (p.total_matches <= fullCorpus ? null : `${JSON.stringify(args)} should still parse and filter`),
  });
}

// --- a filter the subset cannot honour is an error, not a no-op -------------
// `references` has no `newspaper` column: this used to return the whole subset.
await call("get_field_distribution", { field: "subject", subset: "references", newspaper: "Sidwaya" }, {
  expectError: true,
  checkBody: (b) =>
    b.includes("not available on subset") ? null : `an unhonourable filter should error: ${b.slice(0, 160)}`,
});
await call("get_field_distribution", { field: "newspaper", subset: "references" }, {
  expectError: true,
  checkBody: (b) => (b.includes("not available") ? null : "ranking a missing column should still error"),
});

await call("get_lexical_metrics", {}, {
  structured: true,
  check: (p) => {
    if (p.group_by !== "year") return "default grouping should be year";
    if (!p.groups?.length) return "no lexical groups";
    const g = p.groups.find((x) => x.group === "1995");
    if (!g) return "1995 group missing";
    if (g.readability_avg !== 41.5) return `1995 readability should be 41.5, got ${g.readability_avg}`;
    if (g.mattr_avg !== 0.62) return `1995 MATTR should be 0.62, got ${g.mattr_avg}`;
    if (!p.metrics?.mattr) return "metrics descriptor missing";
    return null;
  },
});
await call("get_lexical_metrics", { group_by: "country" }, {
  check: (p) => (p.groups?.some((g) => g.group === "Benin") ? null : "country grouping missing Benin"),
});

// Cross-model sentiment: the whole panel, and how far it agrees. Every model
// identifier here is the EXACT generation-2 model that scored the corpus,
// because a polarity share is meaningless without knowing what produced it.
await call("get_sentiment_distribution", { model: "all" }, {
  structured: true,
  check: (p) => {
    if (String(p.models) !== "gpt-5-6-luna,mistral-small-2603,deepseek-v4-flash-0731,gemma-4-31b-it,qwen3-8-27b")
      return `models wrong: ${p.models}`;
    if (!p.by_model?.["mistral-small-2603"]?.polarity_distribution) return "per-model distributions missing";
    if (!p.by_model?.["gemma-4-31b-it"]?.polarity_distribution) return "the fourth model's distribution is missing";
    if (!p.by_model?.["qwen3-8-27b"]?.polarity_distribution) return "the fifth model's distribution is missing";
    // 5, not 6: qwen annotated nothing on row 104, so the common base is
    // SMALLER than the matched set. This is the assertion that fails if the
    // agreement base is ever silently widened back to every matched article.
    if (p.agreement?.scored_by_all !== 5)
      return `only 5 fixture articles carry all five judgements, got ${p.agreement?.scored_by_all}`;
    // Only 105 (Neutre) survives all five. 102 was unanimous among the first
    // three and gemma reads it Neutre — the row that proves a new member
    // actually moves the agreement number rather than riding along with it.
    if (p.agreement.unanimous !== 1) return `expected 1 unanimous article, got ${p.agreement.unanimous}`;
    // 1 of 5, not 1 of 6: the shrunken base moves the percentage too.
    if (p.agreement.unanimous_percent !== 20) return `expected 20%, got ${p.agreement.unanimous_percent}`;
    // 5 models → 10 unordered pairs, not 6.
    if (Object.keys(p.agreement.pairwise ?? {}).length !== 10)
      return `expected 10 pairwise counts, got ${JSON.stringify(p.agreement.pairwise)}`;
    if (p.agreement.pairwise?.["gpt-5-6-luna~gemma-4-31b-it"] === undefined) return "pairwise agreement missing a pair";
    if (p.agreement.pairwise?.["gemma-4-31b-it~qwen3-8-27b"] === undefined) return "pairwise agreement missing qwen";
    // The uneven coverage must be stated, not left to be inferred from a
    // distribution that drops its unscored key.
    if (p.by_model["qwen3-8-27b"].coverage?.polarity !== 5)
      return `qwen coverage should be 5, got ${JSON.stringify(p.by_model["qwen3-8-27b"].coverage)}`;
    if (p.by_model["gpt-5-6-luna"].coverage?.polarity !== 6)
      return `luna coverage should be 6, got ${JSON.stringify(p.by_model["gpt-5-6-luna"].coverage)}`;
    if (!/12,098/.test(p.by_model["qwen3-8-27b"].model_caveat ?? ""))
      return "qwen's coverage caveat should travel with its numbers";
    if (p.by_model["gpt-5-6-luna"].model_caveat !== undefined)
      return "a complete model must not carry a coverage caveat";
    if (!p.agreement.base_caveats?.["qwen3-8-27b"]) return "the agreement base should name the short model";
    if (p.agreement_matrix?.rows !== "gpt-5-6-luna") return "confusion matrix rows should be the default model";
    return null;
  },
});
// The newest panel member, asked for by id and by vendor shorthand. `google`
// resolving here is the deliberate counterpart to `gemini` still being refused
// below: one is a vendor, the other a model line that never ran generation 2.
await call("get_sentiment_distribution", { model: "gemma-4-31b-it" }, {
  structured: true,
  check: (p) => {
    if (p.model !== "gemma-4-31b-it") return `model not echoed, got ${p.model}`;
    if (p.polarity_distribution?.Neutre !== 4)
      return `gemma reads 4 of 6 fixture rows Neutre, got ${JSON.stringify(p.polarity_distribution)}`;
    if (p.subjectivity?.scored !== 6) return `gemma scores every fixture row, got ${JSON.stringify(p.subjectivity)}`;
    return null;
  },
});
await call("get_sentiment_distribution", { model: "google" }, {
  structured: true,
  check: (p) => (p.model === "gemma-4-31b-it" ? null : `the google shorthand should resolve to Gemma, got ${p.model}`),
});
// The fifth member, and the only one whose single-model answer has to disclose
// its own shortfall: 5 of the 6 matched rows, not 6.
await call("get_sentiment_distribution", { model: "qwen" }, {
  structured: true,
  check: (p) => {
    if (p.model !== "qwen3-8-27b") return `the qwen shorthand should resolve to the model id, got ${p.model}`;
    if (p.total_articles !== 6) return `6 fixture articles match, got ${p.total_articles}`;
    if (p.coverage?.polarity !== 5 || p.coverage?.matched_articles !== 6)
      return `qwen should report 5 of 6 scored, got ${JSON.stringify(p.coverage)}`;
    if (p.subjectivity?.scored !== 5) return `qwen scores 5 fixture rows, got ${JSON.stringify(p.subjectivity)}`;
    if (!/12,098/.test(p.model_caveat ?? "")) return "the single-model answer should carry qwen's caveat";
    return null;
  },
});
await call("get_sentiment_distribution", { model: "mistral-small-2603" }, {
  structured: true,
  check: (p) => {
    if (p.model !== "mistral-small-2603") return "model not echoed";
    if (p.by_model) return "a single-model call should not return by_model";
    if (p.polarity_distribution?.Neutre !== 3) return `Neutre should be 3, got ${JSON.stringify(p.polarity_distribution)}`;
    // Subjectivity is an ordinal LABEL in generation 2, so the distribution is
    // keyed by label and any scalar must be flagged as a derived rank.
    const subj = p.subjectivity ?? {};
    if (subj.distribution?.["Plutôt objectif"] !== 3) return `label buckets wrong: ${JSON.stringify(subj.distribution)}`;
    if (!String(subj.scale ?? "").includes("Très subjectif")) return "subjectivity must declare its label scale";
    if (subj.mean_rank > 5 || subj.mean_rank < 1) return `mean_rank ${subj.mean_rank} outside the scale`;
    if (subj.mean !== undefined) return "the generation-1 numeric `mean` key must be gone";
    if (!subj.caveat) return "subjectivity must ship its reliability caveat";
    return null;
  },
});
// A model that declines to score some articles it did place on the other scales
// must reconcile, not silently shrink the denominator.
await call("get_sentiment_distribution", { model: "deepseek" }, {
  structured: true,
  check: (p) =>
    p.subjectivity?.scored === 5 && p.subjectivity?.unscored === 1
      ? null
      : `unscored subjectivity not reconciled: ${JSON.stringify(p.subjectivity)}`,
});
// The panel's own conclusion. The three fields deliberately do NOT behave alike,
// and every assertion here is about a way they differ.
await call("get_sentiment_distribution", { model: "consensus" }, {
  structured: true,
  check: (p) => {
    if (p.model !== "consensus") return `model not echoed, got ${p.model}`;
    if (p.by_model) return "consensus is not a per-model breakdown";
    // Row 103 has no polarity majority and row 104 no centrality majority, so
    // both label fields resolve on 5 of the 6 matched articles. The empty value
    // must not appear as a bucket.
    if (p.polarity_distribution?.[""] !== undefined) return "the no-majority rows must not be a bucket";
    if (p.coverage?.polarity !== 5) return `polarity consensus should cover 5, got ${JSON.stringify(p.coverage)}`;
    if (p.coverage?.centrality !== 5) return `centrality consensus should cover 5, got ${JSON.stringify(p.coverage)}`;
    // The asymmetry that makes consensus more than a fourth model: subjectivity
    // is a MEDIAN, so it resolves where a majority cannot form. If this ever
    // equals the label fields, the median has been reduced to a vote.
    if (p.coverage?.subjectivity !== 6)
      return `subjectivity median should resolve on all 6, got ${JSON.stringify(p.coverage)}`;
    const subj = p.subjectivity_median_rank ?? {};
    if (subj.distribution?.["2"] !== 3) return `median ranks wrong: ${JSON.stringify(subj.distribution)}`;
    if (p.subjectivity !== undefined) return "the label-shaped subjectivity block must not be used for a median";
    if (!/[Mm]edian of the votes cast/.test(subj.note ?? "")) return "the median must say it is not a majority";
    // Dispute counts: polarity split on 103, centrality on 104, subjectivity on
    // every row but 105.
    if (p.disputed?.polarite !== 1 || p.disputed?.centralite !== 1)
      return `label disputes wrong: ${JSON.stringify(p.disputed)}`;
    if (p.disputed?.subjectivite !== 5 || p.disputed?.any !== 5)
      return `subjectivity disputes wrong: ${JSON.stringify(p.disputed)}`;
    if (!/NO MAJORITY/.test(p.note ?? "")) return "an empty consensus value must be explained, not left ambiguous";
    return null;
  },
});
// consensus is NOT a model, so it must never be reachable through the model
// registry: that is the line keeping a derived aggregate out of a field that
// otherwise always names the exact model that judged.
await call("get_sentiment_distribution", { model: "consensus-polarite" }, {
  expectError: true,
  checkBody: (b) => (b.includes("Invalid model") ? null : `expected an invalid-model error, got: ${b.slice(0, 200)}`),
});
// model:"all" answers "how far do they agree"; the consensus rides along so the
// caller also gets "and what did they conclude" without a second call. Row 104
// is the proof they are not the same set: qwen skipped it, so it is absent from
// scored_by_all yet present in the consensus.
await call("get_sentiment_distribution", { model: "all" }, {
  structured: true,
  check: (p) => {
    if (!p.consensus) return "model:all should carry the panel's conclusion";
    if (p.consensus.coverage?.polarity !== 5) return `consensus coverage wrong: ${JSON.stringify(p.consensus.coverage)}`;
    if (p.agreement?.scored_by_all !== 5) return "agreement base changed unexpectedly";
    if (p.consensus.polarity_distribution?.Neutre !== 3)
      return `row 104 should be decided by its 4 remaining voters: ${JSON.stringify(p.consensus.polarity_distribution)}`;
    return null;
  },
});
// Reading the contested articles, not just counting them.
await call("search_by_sentiment", { disputed: "polarite" }, {
  check: (p) => (p.total_matches === 1 ? null : `only article 103 splits on polarity, got ${p.total_matches}`),
});
await call("search_by_sentiment", { disputed: "subjectivite" }, {
  check: (p) => (p.total_matches === 5 ? null : `5 fixture rows split on subjectivity, got ${p.total_matches}`),
});
// English field names are NOT the stored vocabulary, so they must fail loudly
// with the real values rather than silently matching nothing.
await call("search_by_sentiment", { disputed: "polarity" }, {
  expectError: true,
  checkBody: (b) =>
    b.includes("polarite") ? null : `the error should list the stored field names, got: ${b.slice(0, 200)}`,
});
// Vendor shorthand resolves to the model that ran, and the payload echoes the id.
await call("get_sentiment_distribution", { model: "chatgpt" }, {
  structured: true,
  check: (p) => (p.model === "gpt-5-6-luna" ? null : `vendor alias should resolve to the model id, got ${p.model}`),
});
// The raw dataset column prefix is accepted too (underscores ≡ hyphens).
await call("get_sentiment_distribution", { model: "mistral_small_2603" }, {
  structured: true,
  check: (p) => (p.model === "mistral-small-2603" ? null : `column prefix should resolve, got ${p.model}`),
});
// A generation-1 id names a real annotator this server no longer serves. It
// must say so rather than answer with the same vendor's generation-2 model,
// which read the corpus differently.
for (const retired of ["gpt-5-mini", "gemini-3-flash-preview", "ministral-14b-2512", "gemini"]) {
  await call("get_sentiment_distribution", { model: retired }, {
    expectError: true,
    checkBody: (b) =>
      b.includes("generation-2") && b.includes("gpt-5-6-luna")
        ? null
        : `retired model ${retired} should be refused by name, got: ${b.slice(0, 200)}`,
  });
}
await call("get_sentiment_distribution", { model: "llama" }, {
  expectError: true,
  checkBody: (b) =>
    b.includes("valid_values") && b.includes("deepseek-v4-flash-0731")
      ? null
      : "an unknown model should list the valid ones by model id",
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
// Unaccented and lower-cased: the real vocabulary is accented French
// ("Vidéo sur le web"), so a caller typing it plainly must still match.
await call("search_audiovisual", { medium: "video sur le web" }, {
  check: (p) => (p.total_matches === 1 ? null : `case/accent-folded medium should match 1 video, got ${p.total_matches}`),
});
await call("search_audiovisual", { medium: "vinyl" }, {
  expectError: true,
  checkBody: (b) => (b.includes("valid_values") ? null : "invalid medium should error with valid_values"),
});
await call("list_audiovisual", {}, {
  check: (p) => {
    if (p.total_matches !== 3) return `expected 3 audiovisual items, got ${p.total_matches}`;
    // Newest first, so the harvested video leads: it has a watch URL and NO
    // file, and a row must show which of the two it is without a second call.
    const first = p.results?.[0];
    if (first?.id !== "603") return `expected the newest row first, got ${first?.id}`;
    if (first?.source_type !== "youtube") return "list rows should carry source_type";
    if (!first?.external_url?.includes("youtube.com")) return "a harvested row must expose its watch URL";
    if (first?.media_url) return "a harvested row has no file, so it must not advertise a media_url";
    if (first?.duration_seconds !== 411) return `expected the duration in seconds, got ${first?.duration_seconds}`;
    if (!p.results?.some((r) => r.media_url)) return "the deposited rows should still expose media_url";
    return null;
  },
});
// The two cohorts are separable, and each filter finds the right one. Until the
// fixture held a harvested row, both of these passed by matching nothing.
await call("list_audiovisual", { source_type: "youtube" }, {
  check: (p) => (p.total_matches === 1 ? null : `source_type=youtube should match 1, got ${p.total_matches}`),
});
await call("list_audiovisual", { source_type: "deposited" }, {
  check: (p) => (p.total_matches === 2 ? null : `source_type=deposited should match 2, got ${p.total_matches}`),
});
await call("list_audiovisual", { source_type: "vhs" }, {
  expectError: true,
  checkBody: (b) => (b.includes("valid_values") ? null : "an invalid source_type should error with valid_values"),
});
// The subset is no longer Nigeria-only: country must select either cohort.
await call("list_audiovisual", { country: "Burkina Faso" }, {
  check: (p) => {
    if (p.total_matches !== 1) return `Burkina Faso should match the harvested video, got ${p.total_matches}`;
    return p.results?.[0]?.id === "603" ? null : `wrong row for Burkina Faso: ${p.results?.[0]?.id}`;
  },
});
await call("list_audiovisual", { country: "Nigeria" }, {
  check: (p) => (p.total_matches === 2 ? null : `Nigeria should still match the deposited pair, got ${p.total_matches}`),
});
// The channel facet: 27 of 1,771 real rows carry a subject, 1,769 carry a
// publisher, so this is the one that has to work. Substring, because nobody
// types "RTB - Radiodiffusion Télévision du Burkina".
await call("search_audiovisual", { publisher: "RTB" }, {
  check: (p) => (p.total_matches === 1 ? null : `publisher substring should match the channel, got ${p.total_matches}`),
});
await call("search_audiovisual", { publisher: "radiodiffusion television" }, {
  check: (p) => (p.total_matches === 1 ? null : "publisher matching must be accent- and case-insensitive"),
});
await call("get_audiovisual", { audiovisual_id: 601 }, {
  check: (p) => {
    if (!p.media_url || p.medium !== "CD") return "get_audiovisual missing media_url/medium";
    if (p.source_type !== "deposited") return "get_audiovisual should say which cohort the row is from";
    if (!p.transcription) return "get_audiovisual should expose the OCR transcription";
    if (!p.description?.includes("matafiyi")) return "get_audiovisual should expose the full description";
    if (p.duration_seconds !== 3480 || p.extent !== "PT58M") return "get_audiovisual should expose both duration forms";
    if (!p.rights) return "get_audiovisual should expose rights";
    return null;
  },
});
// The record #20 was opened for: three links with three meanings. The IWAC page
// is the citable one, the watch URL is where the video plays, and media_url —
// absent here — is a file. Inferring "every PDF is a file" was the old contract.
await call("get_audiovisual", { audiovisual_id: 603 }, {
  check: (p) => {
    if (!p.url?.includes("/item/603")) return "get_audiovisual should return the IWAC catalogue page";
    if (p.external_url !== "https://www.youtube.com/watch?v=xcGWG5msEEs") return `wrong watch URL: ${p.external_url}`;
    if (p.media_url) return "a harvested row must not report a media file it does not have";
    if (p.iiif_manifest) return "a harvested row has a 0-canvas manifest, so it must not advertise one";
    if (p.publisher !== "RTB - Radiodiffusion Télévision du Burkina") return "the channel should be the publisher";
    if (p.creator) return "harvested rows carry no creator";
    if (!p.description?.includes("Ouagadougou")) return "the blurb is the only text this row has";
    if (p.transcription) return "this row has no transcription";
    return null;
  },
});
await call("search_audiovisual", { keyword: "Tafsirin" }, {
  check: (p) => (p.total_matches === 1 ? null : `transcription text should be searchable, got ${p.total_matches}`),
});
// `description` is the only text 1,465 of the 1,771 real rows have, so it must be
// in the search surface — and in the FAST half of it, since the unified `search`
// only falls through to the heavy transcription scan when a page under-fills.
await call("search_audiovisual", { keyword: "concorde" }, {
  check: (p) => (p.total_matches === 1 ? null : `description text should be searchable, got ${p.total_matches}`),
});
await call("search", { query: "concorde" }, {
  structured: true,
  check: (p) =>
    p.results?.some((r) => r.id === "audiovisual:602")
      ? null
      : "an audiovisual item should be findable through unified search by its description alone",
});
// Search rows carry a capped snippet, not the whole blurb; the full text is one
// get_audiovisual away. Mirrors references' abstract_snippet.
await call("search_audiovisual", { keyword: "Retransmission" }, {
  check: (p) => {
    const row = p.results?.[0];
    if (!row) return "no row to inspect for the description snippet";
    if (!row.description_snippet?.includes("Retransmission")) return "search rows should carry description_snippet";
    if (row.description) return "search rows should carry the snippet, not the full description";
    return null;
  },
});
// 602 has a description and no transcription: `fetch` must answer with the
// description rather than "(no full text available)", and say which it gave.
await call("fetch", { id: "audiovisual:602" }, {
  structured: true,
  check: (p) => {
    if (!p.text?.includes("Retransmission")) return `fetch should fall back to the description, got: ${String(p.text).slice(0, 60)}`;
    if (p.text_source !== "description") return "fetch should disclose that `text` is the description, not a transcription";
    if (p.metadata?.description) return "the description should not be repeated in metadata once it IS the text";
    return null;
  },
});
// 601 has both: the transcription is the body, and the description stays beside it.
await call("fetch", { id: "audiovisual:601" }, {
  structured: true,
  check: (p) => {
    if (!p.text?.includes("Tafsirin")) return "fetch should prefer the transcription over the description";
    if (p.text_source) return "text_source should be absent when the body column supplied the text";
    if (!p.metadata?.description) return "the description should ride in metadata when the transcription is the text";
    return null;
  },
});

// --- images (photographs) ------------------------------------------------------
await call("search_images", {}, {
  check: (p) => {
    if (p.total_matches !== 3) return `expected 3 photographs, got ${p.total_matches}`;
    const first = p.results?.[0];
    if (!first?.image_url) return "image results must carry image_url";
    if (!first?.coordinates) return "image results must carry coordinates";
    return null;
  },
});
await call("search_images", { country: "Togo" }, {
  check: (p) => (p.total_matches === 1 ? null : `Togo should match 1 photograph, got ${p.total_matches}`),
});
await call("search_images", { spatial: "Ouagadougou" }, {
  check: (p) => (p.total_matches === 1 ? null : `place filter should match 1, got ${p.total_matches}`),
});
await call("search_images", { keyword: "ecole" }, {
  check: (p) => (p.total_matches === 1 ? null : `unaccented keyword should reach 'École', got ${p.total_matches}`),
});
await call("search_images", { country: "Atlantis" }, {
  expectError: true,
  checkBody: (b) => (b.includes("valid_values") ? null : "invalid country should error with valid_values"),
});
await call("get_image", { image_id: 702 }, {
  check: (p) => (p.image_url && p.description ? null : "get_image missing image_url/description"),
});
await call("get_image", { image_id: 99999 }, { expectError: true });

// LIKE metacharacters in a keyword must match literally, not as wildcards: an
// unescaped '_' is a single-char wildcard and would match EVERY article.
await call("search_articles", { keyword: "_" }, {
  check: (p) => (p.total_matches === 0 ? null : `literal '_' should match nothing, got ${p.total_matches} (LIKE escaping regressed)`),
});

await client.close();
await transport.close();

// --- degraded dataset: one subset unloadable ----------------------------------
// A subset's first query downloads its parquet, so a single Hugging Face hiccup
// can leave one subset unavailable while the other five are cached and fine.
// `search` must then degrade to the healthy subsets AND name the missing ones —
// a category silently absent from results reads as "nothing there", which is the
// silent-zero trap the enum validation exists to prevent.
{
  const degradedDir = path.join(root, "test", "fixtures-degraded");
  rmSync(degradedDir, { recursive: true, force: true });
  cpSync(path.join(root, "test", "fixtures"), degradedDir, { recursive: true });
  rmSync(path.join(degradedDir, "audiovisual"), { recursive: true, force: true });

  const degradedTransport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "server", "index.js")],
    stderr: "ignore", // the subset-unavailable warning is expected here
    env: { ...process.env, IWAC_CACHE_DIR: degradedDir, IWAC_OFFLINE: "1", IWAC_SEMANTIC_SEARCH_ENABLED: "false" },
  });
  const degradedClient = new Client({ name: "degraded-test", version: "0.0.0" });
  await degradedClient.connect(degradedTransport);
  const { call: degradedCall, failures: degradedFailures } = createHarness(degradedClient, { timeoutMs: 60_000 });

  await degradedCall("search", { query: "pèlerinage" }, {
    structured: true,
    check: (p) => {
      if (!p.results?.length) return "search should still return hits from the 5 healthy subsets";
      if (p.results.some((r) => r.category === "audiovisual")) return "unloadable subset must not yield results";
      if (!p.unavailable_categories?.includes("audiovisual"))
        return `unavailable subset must be named, got ${JSON.stringify(p.unavailable_categories)}`;
      if (!p.coverage_warning) return "missing coverage_warning for a partially unavailable search";
      return null;
    },
  });
  // A healthy subset's own search_* tool is unaffected by its neighbour's failure.
  await degradedCall("search_articles", { country: "Bénin" }, {
    check: (p) => (p.total_matches === 2 ? null : `healthy subset broken by neighbour failure: ${p.total_matches}`),
  });
  // The failing subset's own tool still reports the failure honestly.
  await degradedCall("search_audiovisual", {}, { expectError: true });

  failuresFromDegraded = degradedFailures();
  await degradedClient.close();
  await degradedTransport.close();
  rmSync(degradedDir, { recursive: true, force: true });
}

// --- the 2026-07-28 era over stdio -------------------------------------------
// Everything above ran on the default `versionNegotiation` — the 2025
// `initialize` handshake — so it proves only the legacy leg. `serveStdio` is
// supposed to serve both eras from one factory; pin the modern revision so
// there is no fallback to mask a regression.
let failuresFromModern = 0;
{
  const modernTransport = new StdioClientTransport({
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
  const modern = new Client(
    { name: "fixture-test-modern", version: "0.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await modern.connect(modernTransport);
  const { call: modernCall, fail: modernFail, failures: modernFailures } = createHarness(modern, { timeoutMs: 60_000 });

  if (modern.getProtocolEra() !== "modern") {
    modernFail(`pinned 2026-07-28 over stdio should negotiate the modern era, got ${modern.getProtocolEra()}`);
  }

  // The handshake `instructions` block is the ENTIRE guidance floor for a
  // skill-less client (ChatGPT via the remote connector). The modern era has no
  // `initialize` result to carry it — it rides `server/discover` instead — so
  // assert it arrives intact rather than trusting that it does.
  const modernInstructions = modern.getInstructions?.() ?? "";
  if (modernInstructions !== instructions) {
    modernFail(
      `instructions differ between eras (legacy ${instructions.length} chars, modern ${modernInstructions.length}) — skill-less clients lose their guidance floor`,
    );
  }

  const modernTools = await modern.listTools();
  if (modernTools.tools.length !== names.length) {
    modernFail(`modern era advertises ${modernTools.tools.length} tools, legacy era ${names.length} — the eras must serve the same factory`);
  }
  // CacheableResult (SEP-2549). The SDK's own default is ttlMs 0 / private, so
  // a 0 here means our cacheHints were dropped, not that the field is missing.
  if (modernTools.ttlMs !== 3_600_000 || modernTools.cacheScope !== "public") {
    modernFail(`tools/list should carry our cache hints, got ttlMs=${modernTools.ttlMs} cacheScope=${modernTools.cacheScope}`);
  }

  // Argument descriptions come from `.describe()` on the Zod schemas. Raw shapes
  // get converted by the SDK's BUNDLED zod, which drops them; explicit
  // z.object() wrapping is what keeps them. They are the only documentation the
  // model gets for an argument, so assert one survived the conversion.
  const searchTool = modernTools.tools.find((t) => t.name === "search");
  if (!searchTool?.inputSchema?.properties?.query?.description) {
    modernFail("search.query lost its .describe() text in the advertised JSON Schema");
  }

  // The MCP App resource and the prompts must be reachable on the modern wire too.
  const modernResources = await modern.listResources();
  if (!modernResources.resources.some((r) => r.uri === "ui://iwac/charts.html")) {
    modernFail("the ui:// chart resource is missing on the modern era");
  }
  const modernPrompts = await modern.listPrompts();
  if (modernPrompts.prompts.length !== promptNames.length) {
    modernFail(`modern era advertises ${modernPrompts.prompts.length} prompts, legacy era ${promptNames.length}`);
  }

  await modernCall("search_articles", { country: "Bénin" }, {
    check: (p) => (p.total_matches === 2 ? null : `accented Bénin on the modern era should match 2, got ${p.total_matches}`),
  });
  await modernCall("get_collection_stats", {}, {
    structured: true,
    check: (p) => (p.subset_counts?.articles === 6 ? null : "collection stats wrong on the modern era"),
  });
  await modernCall("search_articles", { country: "Atlantis" }, {
    expectError: true,
    checkBody: (b) => (b.includes("valid_values") ? null : "invalid country should still error with valid_values on the modern era"),
  });

  failuresFromModern = modernFailures();
  await modern.close();
  await modernTransport.close();
}

const total = failures() + failuresFromDegraded + failuresFromModern;
console.log(`\n${total === 0 ? "ALL FIXTURE CHECKS PASSED" : `${total} FIXTURE CHECK(S) FAILED`}`);
process.exitCode = total === 0 ? 0 : 1;
