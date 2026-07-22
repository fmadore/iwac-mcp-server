// LIVE MCP smoke test with assertions: spawns the built server against the real
// Hugging Face dataset, exercises every tool, and fails (exit 1) on unexpected
// errors or regressions of known bugs (broken date filters, uncapped keyword
// excerpts, accent-sensitive matching, empty-string date aggregates). The
// offline structural twin is test/fixture-server.test.mjs.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { checkManifestParity, createHarness } from "./test/_harness.mjs";

// Pins against the LIVE dataset revision — these are the dataset-drift alarm.
// After a dataset refresh, update them here (one place) if the checks fire.
const EXPECTED = {
  audiovisualTotal: 47, // 45 -> 47 in the July 2026 dataset refresh
  nigerArticles: 1061,
  toolsCore: 25, // semantic disabled (2 semantic tools are dropped entirely)
  toolsWithSemantic: 27,
};

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["server/index.js"],
  stderr: "inherit",
  // Propagate env (e.g. IWAC_SEMANTIC_SEARCH_ENABLED) to the spawned server; the
  // SDK's default child environment otherwise strips arbitrary vars.
  env: process.env,
});

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const { call, fail, failures } = createHarness(client, { verbose: true, timeoutMs: 5 * 60_000 });

const serverVersion = client.getServerVersion()?.version;
console.log(`server version: ${serverVersion}`);
if (!serverVersion || serverVersion === "0.0.0-dev") fail("server version not injected from package.json");

// Instructions parity (the ONLY guidance channel a skill-less client gets):
// must reflect v0.8.x semantics and not the pre-v0.7 single-substring search myth.
const instructions = client.getInstructions?.() ?? "";
const semanticOn = ["1", "true", "yes", "on"].includes(
  (process.env.IWAC_SEMANTIC_SEARCH_ENABLED ?? "").trim().toLowerCase(),
);

if (!instructions) {
  fail("server handshake carried no instructions");
} else {
  if (instructions.includes("as one phrase returns little"))
    fail("instructions still describe `search` as single-substring (multi-word now tokenizes/ANDs)");
  for (const needle of ["valid_values", "mentioned in records from", "requested_limit", "get_temporal_distribution"]) {
    if (!instructions.includes(needle)) fail(`instructions missing guidance: "${needle}"`);
  }
  // The semantic guidance must track registration: mentioned iff the tools exist.
  if (semanticOn !== instructions.includes("semantic_search_articles"))
    fail(`instructions semantic mention (${instructions.includes("semantic_search_articles")}) does not match registration (${semanticOn})`);
}

const tools = await client.listTools();
console.log(`tools (${tools.tools.length}):`, tools.tools.map((t) => t.name).join(", "));
// The 2 semantic_search_* tools register only when IWAC_SEMANTIC_SEARCH_ENABLED=true;
// the live HTTP endpoint runs with it off, so they are dropped there entirely.
const expectedTools = semanticOn ? EXPECTED.toolsWithSemantic : EXPECTED.toolsCore;
if (tools.tools.length !== expectedTools) fail(`expected ${expectedTools} tools, got ${tools.tools.length}`);
const semanticPresent = ["semantic_search_articles", "semantic_search_publications"].filter((n) =>
  tools.tools.some((t) => t.name === n),
);
if (semanticOn && semanticPresent.length !== 2) fail(`semantic enabled but only registered: ${semanticPresent.join(", ") || "none"}`);
if (!semanticOn && semanticPresent.length !== 0) fail(`semantic disabled but still registered: ${semanticPresent.join(", ")}`);

// The manifest's advertised tool list must track what the server registers
// (the two optional semantic tools are always advertised in the manifest).
const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
checkManifestParity(fail, manifest, new Set(tools.tools.map((t) => t.name)));

// --- cold-start fan-out (regression guard) ---------------------------------
// MUST be the first tool call: get_collection_stats fans ensureView() across
// all six subsets at once, which is the only path that races getConn(). Running
// it cold (before any single-subset call warms the shared connection) is what
// catches a reintroduced "Table with name articles does not exist" race. Under
// the bug, racing callers build views on throwaway in-memory DBs, so the later
// articles query throws (whole call isError) and/or subset_counts go null.
await call("get_collection_stats", {}, {
  structured: true,
  check: (p) => {
    if (p.failed_subsets?.length) return `failed_subsets: ${p.failed_subsets} (view built on the wrong connection?)`;
    if (Object.keys(p.subset_counts ?? {}).length !== 6) return `expected 6 subset counts, got ${JSON.stringify(p.subset_counts)}`;
    if (!(p.date_range?.earliest && p.date_range.earliest >= "1900"))
      return `date_range missing/garbled: ${JSON.stringify(p.date_range)}`;
    return null;
  },
});

// --- index / lists ---------------------------------------------------------
await call("search_index", { keyword: "Ouagadougou", limit: 2 }, {
  check: (p) => (p.total_matches > 0 ? null : "no matches for Ouagadougou"),
});
await call("search_index", { keyword: "Dahomey", limit: 2 }, {
  check: (p) =>
    p.results?.some((r) => r.title === "Bénin")
      ? null
      : "alias search for Dahomey did not find canonical Bénin entry",
});
// Unaccented type value must still match "Événements" (accent-insensitive matching).
await call("search_index", { keyword: "a", index_type: "evenements", limit: 1 }, {
  check: (p) => (p.total_matches > 0 ? null : "unaccented index_type 'evenements' matched nothing"),
});
await call("list_subjects", { limit: 3 }, { check: (p) => (p.count === 3 ? null : "expected 3 subjects") });
await call("list_locations", { country: "Burkina Faso", limit: 3 });
await call("list_persons", { limit: 3 });
// NB: audiovisual descriptionAI is empty corpus-wide in the current revision,
// so rows legitimately carry no description_ai key.
await call("list_audiovisual", { limit: 2 }, {
  check: (p) => {
    if (p.total_matches !== EXPECTED.audiovisualTotal) return `expected ${EXPECTED.audiovisualTotal} audiovisual items, got ${p.total_matches}`;
    if (!p.results?.[0]?.medium) return "list_audiovisual should expose medium";
    if (!p.results?.[0]?.media_url) return "list_audiovisual should expose media_url";
    return null;
  },
});
const avHits = await call("search_audiovisual", { language: "Haoussa", limit: 2 }, {
  check: (p) => {
    if (p.total_matches < 20) return `expected many Hausa audiovisual items, got ${p.total_matches}`;
    if (!p.results?.[0]?.creator && !p.results?.[0]?.publisher) return "search_audiovisual should expose creator/publisher metadata when present";
    return null;
  },
});
const avId = avHits?.results?.[0]?.id;
if (avId) {
  await call("get_audiovisual", { audiovisual_id: Number(avId) }, {
    check: (p) => {
      if (!p.url) return "get_audiovisual missing IWAC URL";
      if (!p.media_url) return "get_audiovisual missing media_url";
      if (!p.medium) return "get_audiovisual missing medium";
      return null;
    },
  });
} else {
  fail("search_audiovisual returned no id to drill into");
}
await call("get_index_entry", { entry_id: 376 });

// --- references -------------------------------------------------------------
const refs = await call("search_references", { keyword: "Islam", limit: 2 }, {
  check: (p) => (p.total_matches > 100 ? null : "suspiciously few reference matches"),
});
const refId = refs?.results?.[0]?.id;
if (refId) {
  await call("get_reference", { reference_id: Number(refId) }, {
    check: (p) => (p.id ? null : "get_reference returned no id"),
  });
} else {
  fail("search_references returned no id to drill into");
}
// Niger must not match Nigeria-only references (pipe-aware exact country match).
await call("search_references", { country: "Nigeria", limit: 1 }, {
  check: (p) => (p.total_matches > 0 && p.total_matches < 100 ? null : `Nigeria count looks wrong: ${p.total_matches}`),
});
await call("search_references", { subject: "state", limit: 1 }, {
  check: (p) => (p.total_matches > 0 && p.total_matches < 30 ? null : `pipe-aware reference subject filter looks wrong: ${p.total_matches}`),
});

// --- publications ------------------------------------------------------------
await call("search_publications", { keyword: "pèlerinage", limit: 2 });
await call("list_periodicals", {}, {
  structured: true,
  check: (p) => (p.total_periodicals >= 10 ? null : "expected >= 10 periodicals"),
});
// Excerpt cap: a common keyword on a ~1.1M-char issue must stay bounded.
await call("get_publication_fulltext", { publication_id: 44763, keyword: "islam" }, {
  check: (p, body) => {
    if (!(p.match_count >= 20)) return `expected many matches, got ${p.match_count}`;
    if (!(p.excerpts_returned <= 10)) return `excerpts_returned ${p.excerpts_returned} exceeds default cap`;
    if (body.length > 80_000) return `response too large: ${body.length} chars`;
    return null;
  },
});
// Accent check on the JS excerpt path: unaccented keyword, accented OCR.
await call("get_publication_fulltext", { publication_id: 11763, keyword: "pelerinage" }, {
  check: (p) => (p.match_count > 0 ? null : "unaccented keyword found no excerpts in accented OCR"),
});

// --- articles ----------------------------------------------------------------
// (get_collection_stats runs first, as a cold-start regression guard — see top.)
// Accent-insensitive keyword: unaccented query must reach the accented corpus.
await call("search_articles", { keyword: "pelerinage", limit: 1 }, {
  check: (p) => (p.total_matches > 1000 ? null : `accent folding broken: ${p.total_matches} matches`),
});
// Accented country input must match the dataset's unaccented "Benin".
await call("search_articles", { country: "Bénin", limit: 1 }, {
  check: (p) => (p.total_matches > 1500 ? null : `country folding broken: ${p.total_matches}`),
});
// THE former P0: date-filtered search must not throw a Binder Error.
await call("search_articles", { keyword: "ramadan", date_from: "1995-01-01", date_to: "1999-12-31", limit: 3 }, {
  check: (p) => (p.total_matches > 0 ? null : "date-filtered search returned nothing"),
});
await call("search_articles", { country: "Burkina Faso", with_description: true, limit: 2 }, {
  check: (p) => (p.results?.[0]?.description_ai ? null : "with_description did not add description_ai"),
});
await call("search_articles", { subject: "Mosquée", limit: 1 }, {
  check: (p) => (p.total_matches > 1000 && p.total_matches < 1500 ? null : `pipe-aware subject filter looks wrong for Mosquée: ${p.total_matches}`),
});
await call("get_newspaper_stats", { country: "Niger" }, {
  structured: true,
  check: (p) => (p.total_articles === EXPECTED.nigerArticles ? null : `Niger article count ${p.total_articles}, expected ${EXPECTED.nigerArticles} (Nigeria conflation?)`),
});
await call("search_by_sentiment", { polarity: "tres positif", limit: 2 }, {
  check: (p) => (p.total_matches > 1000 ? null : `unaccented polarity matched ${p.total_matches}`),
});
await call("get_sentiment_distribution", { country: "Benin" }, {
  structured: true,
  check: (p) => (p.total_articles > 1500 ? null : `Benin distribution looks wrong: ${p.total_articles}`),
});
await call("get_country_comparison", {}, { structured: true });
// get_temporal_distribution (new in v0.9.0): a real trend query must return a
// sane multi-year distribution whose counts reconcile with total_matches.
await call("get_temporal_distribution", { keyword: "ramadan", country: "Benin" }, {
  structured: true,
  check: (p) => {
    const years = Object.keys(p.distribution ?? {});
    if (years.length < 5) return `expected a multi-year ramadan distribution, got ${years.length} buckets`;
    const sum = Object.values(p.distribution).reduce((a, b) => a + b, 0);
    if (sum !== p.dated_count) return `distribution sum ${sum} != dated_count ${p.dated_count}`;
    if (p.total_matches !== p.dated_count + p.undated_count) return "counts do not reconcile";
    return null;
  },
});
await call("get_temporal_distribution", { subset: "references", keyword: "islam" }, {
  check: (p) => (Object.keys(p.distribution ?? {}).length > 3 ? null : "reference timeline suspiciously flat"),
});
await call("get_article", { article_id: 67613 }, {
  check: (p) => (p.description_ai ? null : "get_article lacks description_ai"),
});

// --- documents ----------------------------------------------------------------
// Individual documents may legitimately lack OCR (the July 2026 refresh added
// one that sorts first), so drill through the first few results until one
// yields OCR text instead of pinning results[0] — the check guards OCR
// *retrieval*, not any single item's contents.
const docs = await call("search_documents", {}, {
  check: (p) => (p.total_matches >= 20 ? null : `expected ~26 documents, got ${p.total_matches}`),
});
const docIds = (docs?.results ?? []).map((r) => r.id).filter(Boolean).slice(0, 5);
if (docIds.length === 0) {
  fail("search_documents returned no id to drill into");
} else {
  let sawOcr = false;
  for (const id of docIds) {
    const doc = await call("get_document", { document_id: Number(id) }, {
      check: (p) => (p.id ? null : "get_document returned no row"),
    });
    if (doc?.ocr_text) {
      sawOcr = true;
      break;
    }
  }
  if (!sawOcr) fail(`none of the first ${docIds.length} documents returned OCR text (retrieval regressed?)`);
}

// --- unified search / fetch (OpenAI Deep Research contract) -------------------
const searchHits = await call("search", { query: "ramadan", limit: 5 }, {
  structured: true,
  check: (p) => {
    if (!Array.isArray(p.results) || p.results.length === 0) return "search returned no results";
    const bad = p.results.find((r) => !r.id || !/^[a-z_]+:.+/.test(r.id) || !r.url);
    if (bad) return `result missing namespaced id/url: ${JSON.stringify(bad)}`;
    if (typeof p.ranking !== "string" || !p.ranking) return "search response missing ranking note";
    if (!p.results.every((r) => typeof r.category === "string")) return "search results missing category";
    return null;
  },
});
// Tokenize-AND regression guard: a multi-word query must still match. The
// single-substring keyword filters look for the literal phrase and return
// nothing here — search() splits into tokens and ANDs them.
await call("search", { query: "Islam Niger", limit: 5 }, {
  check: (p) =>
    Array.isArray(p.results) && p.results.length > 0
      ? null
      : "multi-word query matched nothing (tokenization regressed)",
});
const fetchId = searchHits?.results?.[0]?.id;
if (fetchId) {
  await call("fetch", { id: fetchId }, {
    structured: true,
    check: (p) => {
      if (!p.url) return "fetch result missing url";
      if (typeof p.text !== "string" || p.text.length === 0) return "fetch result missing text";
      return null;
    },
  });
} else {
  fail("search returned no id to fetch");
}
// Missing & malformed ids must error AND advertise the valid categories (discoverability).
await call("fetch", { id: "articles:999999999" }, {
  expectError: true,
  checkBody: (b) =>
    b.includes("valid_categories") && b.includes("audiovisual")
      ? null
      : `missing-id error should list valid_categories: ${b.slice(0, 160)}`,
});
await call("fetch", { id: "garbage" }, {
  expectError: true,
  checkBody: (b) => (b.includes("valid_categories") ? null : "malformed-id error should list valid_categories"),
});

// --- strict enum validation + limit transparency (new in v0.8.0) -------------
// Invalid enumerated filters must error with valid_values, not silently return 0
// rows (which reads as a real historical absence).
await call("search_articles", { country: "Atlantis", limit: 1 }, {
  expectError: true,
  checkBody: (b) =>
    b.includes("valid_values") && b.includes("Burkina Faso")
      ? null
      : `invalid country should error with valid_values: ${b.slice(0, 160)}`,
});
await call("search_by_sentiment", { polarity: "ecstatic", limit: 1 }, {
  expectError: true,
  checkBody: (b) => (b.includes("valid_values") ? null : "invalid polarity should list valid_values"),
});
await call("search_index", { keyword: "a", index_type: "people", limit: 1 }, {
  expectError: true,
  checkBody: (b) => (b.includes("valid_values") ? null : "invalid index_type should list valid_values"),
});
// A valid country with no rows is a finding, NOT an error.
await call("search_articles", { country: "Nigeria", limit: 1 }, {
  check: (p) => (Number.isInteger(p.total_matches) ? null : "valid country Nigeria should return a normal envelope"),
});
// Over-max limit is capped VISIBLY: applied limit + requested_limit + warning.
await call("list_subjects", { limit: 500 }, {
  check: (p) => {
    if (p.limit !== 200) return `applied limit should be 200, got ${p.limit}`;
    if (p.requested_limit !== 500) return `requested_limit should be 500, got ${p.requested_limit}`;
    if (!p.limit_warning) return "missing limit_warning when capped";
    return null;
  },
});
// list_locations(country) carries a note disambiguating mentioned-in vs located-in.
await call("list_locations", { country: "Benin", limit: 3 }, {
  check: (p) =>
    typeof p.note === "string" && p.note.includes("mentioned-in")
      ? null
      : "list_locations(country) should carry a mentioned-in semantics note",
});

// --- semantic: registration is gated on IWAC_SEMANTIC_SEARCH_ENABLED, so the
// presence/absence of the two semantic tools is asserted against the tools list
// near the top of this script (no call here — that would need a Google API key). ---

// --- error path ----------------------------------------------------------------
await call("get_article", { article_id: 1 }, { expectError: true });

await client.close();
await transport.close();

console.log(`\n${failures() === 0 ? "ALL CHECKS PASSED" : `${failures()} CHECK(S) FAILED`}`);
process.exitCode = failures() === 0 ? 0 : 1;
