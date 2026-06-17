// MCP smoke test with assertions: spawns the built server, exercises every tool,
// and fails (exit 1) on unexpected errors or regressions of known bugs
// (broken date filters, uncapped keyword excerpts, accent-sensitive matching,
// empty-string date aggregates).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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

let failures = 0;
function fail(msg) {
  failures++;
  console.error(`  FAIL: ${msg}`);
}

const serverVersion = client.getServerVersion()?.version;
console.log(`server version: ${serverVersion}`);
if (!serverVersion || serverVersion === "0.0.0-dev") fail("server version not injected from package.json");

const semanticOn = ["1", "true", "yes", "on"].includes(
  (process.env.IWAC_SEMANTIC_SEARCH_ENABLED ?? "").trim().toLowerCase(),
);

const tools = await client.listTools();
console.log(`tools (${tools.tools.length}):`, tools.tools.map((t) => t.name).join(", "));
// The 2 semantic_search_* tools register only when IWAC_SEMANTIC_SEARCH_ENABLED=true;
// the live HTTP endpoint runs with it off, so they are dropped there entirely.
const expectedTools = semanticOn ? 24 : 22;
if (tools.tools.length !== expectedTools) fail(`expected ${expectedTools} tools, got ${tools.tools.length}`);
const semanticPresent = ["semantic_search_articles", "semantic_search_publications"].filter((n) =>
  tools.tools.some((t) => t.name === n),
);
if (semanticOn && semanticPresent.length !== 2) fail(`semantic enabled but only registered: ${semanticPresent.join(", ") || "none"}`);
if (!semanticOn && semanticPresent.length !== 0) fail(`semantic disabled but still registered: ${semanticPresent.join(", ")}`);

/**
 * Call a tool and run assertions. opts:
 *   expectError — the call SHOULD return isError (default false)
 *   check(parsed, body) — return a failure message string, or falsy if OK
 */
async function call(name, args, opts = {}) {
  const res = await client.callTool({ name, arguments: args });
  const body = res.content?.[0]?.text ?? "";
  const isErr = res.isError === true;
  const preview = body.slice(0, 220).replace(/\s+/g, " ");
  console.log(`\n[${name}] ${isErr ? "ERROR " : ""}${body.length} chars | ${preview}${body.length > 220 ? "..." : ""}`);
  if (isErr !== (opts.expectError ?? false)) {
    fail(`${name}: isError=${isErr}, expected ${opts.expectError ?? false} — ${body.slice(0, 200)}`);
    return null;
  }
  let parsed = null;
  if (!isErr) {
    try {
      parsed = JSON.parse(body);
    } catch {
      fail(`${name}: response is not valid JSON`);
      return null;
    }
  }
  if (opts.check && parsed) {
    const msg = opts.check(parsed, body);
    if (msg) fail(`${name}: ${msg}`);
  }
  return parsed;
}

// --- cold-start fan-out (regression guard) ---------------------------------
// MUST be the first tool call: get_collection_stats fans ensureView() across
// all six subsets at once, which is the only path that races getConn(). Running
// it cold (before any single-subset call warms the shared connection) is what
// catches a reintroduced "Table with name articles does not exist" race. Under
// the bug, racing callers build views on throwaway in-memory DBs, so the later
// articles query throws (whole call isError) and/or subset_counts go null.
await call("get_collection_stats", {}, {
  check: (p) => {
    const nullSubset = Object.entries(p.subset_counts ?? {}).find(([, n]) => n === null);
    if (nullSubset) return `subset_counts.${nullSubset[0]} is null (view built on the wrong connection?)`;
    if (!(p.date_range?.earliest && p.date_range.earliest >= "1900"))
      return `date_range missing/garbled: ${JSON.stringify(p.date_range)}`;
    return null;
  },
});

// --- index / lists ---------------------------------------------------------
await call("search_index", { keyword: "Ouagadougou", limit: 2 }, {
  check: (p) => (p.total_matches > 0 ? null : "no matches for Ouagadougou"),
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
  check: (p) => (p.total_matches === 45 ? null : `expected 45 audiovisual items, got ${p.total_matches}`),
});
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

// --- publications ------------------------------------------------------------
await call("search_publications", { keyword: "pèlerinage", limit: 2 });
await call("list_periodicals", {}, {
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
await call("get_newspaper_stats", { country: "Niger" }, {
  check: (p) => (p.total_articles === 1061 ? null : `Niger article count ${p.total_articles}, expected 1061 (Nigeria conflation?)`),
});
await call("search_by_sentiment", { polarity: "tres positif", limit: 2 }, {
  check: (p) => (p.total_matches > 1000 ? null : `unaccented polarity matched ${p.total_matches}`),
});
await call("get_sentiment_distribution", { country: "Benin" }, {
  check: (p) => (p.total_articles > 1500 ? null : `Benin distribution looks wrong: ${p.total_articles}`),
});
await call("get_country_comparison", {});
await call("get_article", { article_id: 67613 }, {
  check: (p) => (p.description_ai ? null : "get_article lacks description_ai"),
});

// --- documents ----------------------------------------------------------------
const docs = await call("search_documents", {}, {
  check: (p) => (p.total_matches >= 20 ? null : `expected ~26 documents, got ${p.total_matches}`),
});
const docId = docs?.results?.[0]?.id;
if (docId) {
  await call("get_document", { document_id: Number(docId) }, {
    check: (p) => (p.ocr_text ? null : "get_document returned no OCR"),
  });
} else {
  fail("search_documents returned no id to drill into");
}

// --- unified search / fetch (OpenAI Deep Research contract) -------------------
const searchHits = await call("search", { query: "ramadan", limit: 5 }, {
  check: (p) => {
    if (!Array.isArray(p.results) || p.results.length === 0) return "search returned no results";
    const bad = p.results.find((r) => !r.id || !/^[a-z_]+:.+/.test(r.id) || !r.url);
    return bad ? `result missing namespaced id/url: ${JSON.stringify(bad)}` : null;
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
    check: (p) => {
      if (!p.url) return "fetch result missing url";
      if (typeof p.text !== "string" || p.text.length === 0) return "fetch result missing text";
      return null;
    },
  });
} else {
  fail("search returned no id to fetch");
}
await call("fetch", { id: "articles:1" }, { expectError: true }); // unknown id
await call("fetch", { id: "garbage" }, { expectError: true }); // malformed id

// --- semantic: registration is gated on IWAC_SEMANTIC_SEARCH_ENABLED, so the
// presence/absence of the two semantic tools is asserted against the tools list
// near the top of this script (no call here — that would need a Google API key). ---

// --- error path ----------------------------------------------------------------
await call("get_article", { article_id: 1 }, { expectError: true });

await client.close();
await transport.close();

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
