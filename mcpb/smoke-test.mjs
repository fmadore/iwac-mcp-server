// LIVE MCP smoke test with assertions: spawns the built server against the real
// Hugging Face dataset, exercises every tool, and fails (exit 1) on unexpected
// errors or regressions of known bugs (broken date filters, uncapped keyword
// excerpts, accent-sensitive matching, empty-string date aggregates). The
// offline structural twin is test/fixture-server.test.mjs.
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { readFileSync } from "node:fs";
import { checkManifestParity, createHarness } from "./test/_harness.mjs";
import { encode } from "gpt-tokenizer/encoding/o200k_base";

// Pins against the LIVE dataset revision — these are the dataset-drift alarm.
// After a dataset refresh, update them here (one place) if the checks fire.
const EXPECTED = {
  // A FLOOR, not a pin. Audiovisual was a fixed deposit of 47 Nigerian
  // recordings until the 2026-08-17 refresh turned it into a rolling harvest:
  // 1,771 items, of which 1,724 are YouTube videos (Burkina Faso 1,100, Togo
  // 536, Benin 90) still being ingested week by week. Pinning an exact count
  // would now redden the weekly run on ordinary growth; the floor still catches
  // the failure this guards against — the subset emptying or the view breaking.
  audiovisualFloor: 1700,
  imagesTotal: 30, // images subset added in the July 2026 refresh
  nigerArticles: 1061,
  // 27 -> 32 in v0.13.0: get_topic_distribution, get_field_distribution,
  // get_cooccurrence, get_lexical_metrics, get_place_distribution, get_semantic_map,
  // get_similar_items.
  toolsCore: 34, // semantic disabled (3 semantic tools are dropped entirely)
  toolsWithSemantic: 37,
  subsets: 7, // + images
  // Full text is masked per row in the PUBLIC dataset (OCR_is_public). These are
  // the July 2026 ratios; a change here means the upstream publication policy
  // or the masking pipeline moved, not that the server broke.
  // 2026-08-17 refresh: articles 12,356 -> 12,349 and with_fulltext 7,549 ->
  // 7,546 — a net withdrawal of 7 items, 3 of them public-OCR, so the share
  // holds at 61%. Publications did not move. The user-facing copies
  // (INSTRUCTIONS in src/index.ts and its mirror in the iwac-mcp skill) were
  // brought to 7,546/12,349 the same day; the per-column coverage figures in
  // references/tools-by-phase.md (LDA 12,234, embeddings 12,286, signed 9,664)
  // predate the July refresh and still want re-measuring together.
  articlesWithFulltext: 7546,
  publicationsWithFulltext: 1298,
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

// RESPONSE_CEILING mirrors test/token-budget.test.mjs. That test bounds the
// tools whose worst case follows from the server's own caps; this run bounds the
// ones whose size follows from the CORPUS — an aggregate over every distinct
// month, subject or place is only as large as the real data makes it, and no
// synthetic fixture can stand in for that. It measures the calls this file
// already makes, so it is a canary on real sizes rather than a proof about
// maximum arguments; the report below is printed whether or not anything fired.
const RESPONSE_CEILING = 20_000;
const { call, fail, failures, tokenReport } = createHarness(client, {
  verbose: true,
  timeoutMs: 5 * 60_000,
  encode,
  tokenCeiling: RESPONSE_CEILING,
});

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
  // (the semantic guidance is checked against actual registration below, once
  // the tool list and the manifest catalogue are both in hand)
}

const tools = await client.listTools();
console.log(`tools (${tools.tools.length}):`, tools.tools.map((t) => t.name).join(", "));
// The semantic_search_* tools register only when IWAC_SEMANTIC_SEARCH_ENABLED=true;
// the live HTTP endpoint runs with it off, so they are dropped there entirely.
const expectedTools = semanticOn ? EXPECTED.toolsWithSemantic : EXPECTED.toolsCore;
if (tools.tools.length !== expectedTools) fail(`expected ${expectedTools} tools, got ${tools.tools.length}`);

// The manifest's advertised tool list must track what the server registers
// (the optional semantic tools are always advertised in the manifest).
const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
checkManifestParity(fail, manifest, new Set(tools.tools.map((t) => t.name)));

// DERIVED from the manifest, never hardcoded: the manifest is the full
// catalogue, so a semantic tool added there but forgotten in registration or in
// the instructions is caught. A hardcoded pair here is exactly what let
// semantic_search_images ship registered-but-unmentioned.
const semanticNames = manifest.tools.map((t) => t.name).filter((n) => n.startsWith("semantic_search_"));
const semanticPresent = semanticNames.filter((n) => tools.tools.some((t) => t.name === n));
if (semanticOn && semanticPresent.length !== semanticNames.length)
  fail(`semantic enabled but only registered: ${semanticPresent.join(", ") || "none"} (expected all of ${semanticNames.join(", ")})`);
if (!semanticOn && semanticPresent.length !== 0) fail(`semantic disabled but still registered: ${semanticPresent.join(", ")}`);

// The instructions are the ONLY guidance a skill-less client gets, so every
// registered semantic tool must be named there — and none may be when they are off.
if (instructions) {
  for (const n of semanticNames) {
    const mentioned = instructions.includes(n);
    const registered = semanticPresent.includes(n);
    if (mentioned !== registered)
      fail(`instructions mention ${n}=${mentioned} but it is registered=${registered}`);
  }
}

// --- cold-start fan-out (regression guard) ---------------------------------
// MUST be the first tool call: get_collection_stats fans ensureView() across
// all seven subsets at once, which is the only path that races getConn(). Running
// it cold (before any single-subset call warms the shared connection) is what
// catches a reintroduced "Table with name articles does not exist" race. Under
// the bug, racing callers build views on throwaway in-memory DBs, so the later
// articles query throws (whole call isError) and/or subset_counts go null.
await call("get_collection_stats", {}, {
  structured: true,
  check: (p) => {
    if (p.failed_subsets?.length) return `failed_subsets: ${p.failed_subsets} (view built on the wrong connection?)`;
    if (Object.keys(p.subset_counts ?? {}).length !== EXPECTED.subsets)
      return `expected ${EXPECTED.subsets} subset counts, got ${JSON.stringify(p.subset_counts)}`;
    if (p.subset_counts.images !== EXPECTED.imagesTotal)
      return `images subset ${p.subset_counts.images}, expected ${EXPECTED.imagesTotal}`;
    if (!(p.date_range?.earliest && p.date_range.earliest >= "1900"))
      return `date_range missing/garbled: ${JSON.stringify(p.date_range)}`;
    // Full-text coverage is a dataset-policy alarm, not a code check: if these
    // move, the public/private masking upstream changed and every keyword count
    // this server reports covers a different share of the corpus.
    const art = p.fulltext_coverage?.articles;
    const pub = p.fulltext_coverage?.publications;
    if (art?.with_fulltext !== EXPECTED.articlesWithFulltext)
      return `articles with full text ${art?.with_fulltext}, expected ${EXPECTED.articlesWithFulltext}`;
    if (pub?.with_fulltext !== EXPECTED.publicationsWithFulltext)
      return `publications with full text ${pub?.with_fulltext}, expected ${EXPECTED.publicationsWithFulltext}`;
    return null;
  },
});

// --- images (added July 2026) ----------------------------------------------
await call("search_images", {}, {
  check: (p) =>
    p.total_matches === EXPECTED.imagesTotal
      ? null
      : `expected ${EXPECTED.imagesTotal} photographs, got ${p.total_matches}`,
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
// NB: audiovisual descriptionAI is empty corpus-wide in the current revision
// (0 of 1,771), so rows legitimately carry no description_ai key. `medium` (3
// rows empty) and `media_url` (only the 47 deposited items carry one; the 1,724
// harvested web videos link out through `URL` instead) are likewise empty for
// individual items, and empty strings are dropped from responses — so assert
// these across the page rather than on results[0]. Pinning them to the first row
// made the check a hostage to pub_date DESC ordering, which turned a projection
// assertion into a dataset-drift alarm. What is actually under test is that the
// summary projection carries the columns at all.
await call("list_audiovisual", { limit: 5 }, {
  check: (p) => {
    if (!(p.total_matches >= EXPECTED.audiovisualFloor))
      return `expected at least ${EXPECTED.audiovisualFloor} audiovisual items, got ${p.total_matches}`;
    if (!p.results?.some((r) => r.medium)) return "list_audiovisual should expose medium";
    return null;
  },
});
// The deposited Nigerian recordings are the only ones with a media_url, and they
// sort oldest — ask for them by country rather than hoping they land on page 1.
await call("list_audiovisual", { country: "Nigeria", limit: 5 }, {
  check: (p) => {
    if (!(p.total_matches > 0)) return "the deposited Nigerian recordings have vanished from the subset";
    if (!p.results?.some((r) => r.media_url)) return "list_audiovisual should expose media_url";
    return null;
  },
});
// A validated filter whose vocabulary no row can satisfy is worse than no
// validation: every accepted value returns a confident zero. MEDIUM_VALUES was
// taken from the synthetic fixture ("audio" | "video") and matched nothing in
// the real subset until 2026-08-17, and only the live dataset can catch that —
// the hermetic test asserts the fixture agrees with itself. Same for the other
// closed vocabularies, which the enum-error checks below cover from the miss
// side only. Each accepted value must find rows.
for (const medium of ["video sur le web", "DVD", "CD"]) {
  await call("search_audiovisual", { medium, limit: 1 }, {
    check: (p) => (p.total_matches > 0 ? null : `medium='${medium}' passes validation but matches no row`),
  });
}
// `description` is the only substantive text most of this subset has — filled
// for 1,465 of 1,771 rows against 50 transcriptions and zero AI summaries — and
// it reached neither the search surface nor any response until 2026-08-17.
// Measured on the live revision, carrying it takes audiovisual keyword reach for
// "ramadan" from 190 items to 317 and for "imam" from 230 to 358.
const avDesc = await call("search_audiovisual", { keyword: "ramadan", limit: 10 }, {
  check: (p) => {
    if (!(p.total_matches > 200)) return `audiovisual 'ramadan' fell to ${p.total_matches} — is description still searched?`;
    if (!p.results?.some((r) => r.description_snippet)) return "search rows carry no description_snippet";
    if (p.results?.some((r) => r.description)) return "search rows should carry the capped snippet, not the full description";
    return null;
  },
});
// Drill into a row that HAS a description: `fetch` must answer with it rather
// than the "(no full text available)" placeholder, since 1,721 of 1,771 rows
// carry no public transcription to serve as the body.
const describedId = avDesc?.results?.find((r) => r.description_snippet)?.id;
if (describedId) {
  await call("fetch", { id: `audiovisual:${describedId}` }, {
    structured: true,
    check: (p) => {
      if (p.text?.startsWith("(no full text")) return "an item with a description came back as textless";
      if (!p.text_source && !p.metadata?.transcription) return "text arrived from neither the description nor a transcription";
      return null;
    },
  });
} else {
  fail("no audiovisual result carried a description to drill into");
}
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
// The harvested cohort, which the deposited-row checks above cannot see. These
// rows have NO file, so before v3.2.0 a page of results offered no way to reach
// the video and no way to tell "no file" from "broken record" (issue #20). Only
// the live dataset can catch a schema drift here: the fixture agrees with itself.
const yt = await call("search_audiovisual", { source_type: "youtube", limit: 5 }, {
  check: (p) => {
    if (!(p.total_matches > 1000)) return `expected the harvested majority, got ${p.total_matches}`;
    const row = p.results?.[0];
    if (!row) return "no harvested row returned";
    if (row.source_type !== "youtube") return `source_type not echoed on the row: ${row.source_type}`;
    if (!row.external_url) return "a harvested row must carry the URL where the video plays";
    if (row.media_url) return "a harvested row has no file, so media_url must stay absent";
    if (!(row.duration_seconds > 0)) return `expected a duration in seconds, got ${row.duration_seconds}`;
    return null;
  },
});
const ytId = yt?.results?.[0]?.id;
if (ytId) {
  await call("get_audiovisual", { audiovisual_id: Number(ytId) }, {
    check: (p) => {
      if (!p.url?.includes("/item/")) return "get_audiovisual missing the IWAC page";
      if (!p.external_url) return "get_audiovisual missing the watch URL for a harvested row";
      if (!p.publisher) return "a harvested row should name its channel";
      if (!p.rights) return "get_audiovisual missing rights";
      return null;
    },
  });
} else {
  fail("no harvested audiovisual row to drill into");
}
await call("search_audiovisual", { source_type: "deposited", limit: 1 }, {
  check: (p) => (p.total_matches > 0 && p.total_matches < 200 ? null : `deposited count looks wrong: ${p.total_matches}`),
});
await call("search_audiovisual", { source_type: "vhs" }, {
  expectError: true,
  checkBody: (b) => (b.includes("valid_values") ? null : "an invalid source_type should error with valid_values"),
});
// The channel facet, and the country the subset used not to have. Both are
// substring/pipe matches on live values, so a rename upstream shows up here.
await call("search_audiovisual", { publisher: "RTB", limit: 1 }, {
  check: (p) => (p.total_matches > 100 ? null : `the RTB channel should be well represented, got ${p.total_matches}`),
});
await call("list_audiovisual", { country: "Burkina Faso", limit: 1 }, {
  check: (p) => (p.total_matches > 500 ? null : `Burkina Faso audiovisual looks wrong: ${p.total_matches}`),
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
// Bounded on both sides for the same reason as search_by_sentiment below: a
// filter that stopped being applied would return the whole corpus. The ceiling
// is deliberately loose — subject enrichment upstream moves these counts without
// the server changing (Mosquée 1401 -> 1511 between the 2026-08-03 and
// 2026-08-10 weekly runs, alongside Prière 2139 -> 2368 and Paix 1894 -> 2184),
// so it guards the corpus-wide failure, not the exact tally.
await call("search_articles", { subject: "Mosquée", limit: 1 }, {
  check: (p) => (p.total_matches > 1000 && p.total_matches < 4000 ? null : `pipe-aware subject filter looks wrong for Mosquée: ${p.total_matches}`),
});
await call("get_newspaper_stats", { country: "Niger" }, {
  structured: true,
  check: (p) => (p.total_articles === EXPECTED.nigerArticles ? null : `Niger article count ${p.total_articles}, expected ${EXPECTED.nigerArticles} (Nigeria conflation?)`),
});
await call("search_by_sentiment", { polarity: "tres positif", limit: 2 }, {
  // Bounded on BOTH sides: a filter that silently stopped being applied would
  // return the whole corpus and still clear a lower bound on its own. The band
  // is wide because it is per-model — gpt-5-6-luna reads 425 articles as Très
  // positif where mistral-small-2603 reads 2,088 — so it tests that filtering
  // happens, not what any one model concluded.
  check: (p) =>
    p.total_matches > 100 && p.total_matches < 5_000
      ? null
      : `"Très positif" matched ${p.total_matches}, which is not a filtered subset of ~12,300 articles`,
});
// The label vocabulary must be the generation-2 one. A 1-5 rating here used to
// be valid; if it still matched anything, the server would be reading a
// generation-1 column behind a generation-2 vocabulary.
await call("search_by_sentiment", { subjectivity: "tres subjectif", limit: 2 }, {
  check: (p) =>
    p.total_matches > 100 && p.total_matches < 5_000
      ? null
      : `"Très subjectif" matched ${p.total_matches}, which is not a filtered subset of ~12,300 articles`,
});
await call("search_by_sentiment", { subjectivity: "4", limit: 1 }, {
  expectError: true,
  checkBody: (b) =>
    b.includes("Très objectif") ? null : "a numeric subjectivity should error with the label vocabulary",
});
await call("get_sentiment_distribution", { country: "Benin" }, {
  structured: true,
  check: (p) => (p.total_articles > 1500 ? null : `Benin distribution looks wrong: ${p.total_articles}`),
});
await call("get_country_comparison", {}, {
  structured: true,
  check: (p) => {
    if (p.polarity_model !== "gpt-5-6-luna") return `polarity_model wrong: ${p.polarity_model}`;
    return p.countries?.some((c) => c.polarity && Object.keys(c.polarity).length)
      ? null
      : "no country carries polarity — the sentiment column is not being read";
  },
});
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

// --- corpus aggregates (v0.13.0) ------------------------------------------------
// These read columns the fixtures can only imitate — the LDA assignments, the
// two extra sentiment models, the lexical metrics — so the live run is the only
// place their real shape is checked. Every number below was measured against
// the 2026-07-27 dataset; a drift here means the pipeline moved, not the server.
await call("get_topic_distribution", {}, {
  structured: true,
  check: (p) => {
    if (p.topics?.length !== 30) return `expected the 30 LDA topics, got ${p.topics?.length}`;
    if (p.classified < 12_000) return `only ${p.classified} articles carry a topic (was 12,234)`;
    if (p.classified > p.total_matches) return "classified cannot exceed total_matches";
    if (!p.topics[0]?.label?.includes(" - ")) return `topic labels should be hyphenated terms: ${p.topics[0]?.label}`;
    return null;
  },
});
await call("get_field_distribution", { field: "spatial", top_n: 5 }, {
  structured: true,
  check: (p) => {
    if (p.items_with_value < 10_000) return `spatial fill dropped to ${p.items_with_value} (was 10,634)`;
    if (p.distinct_values < 500) return `only ${p.distinct_values} distinct places (was 766)`;
    if (p.values?.[0]?.count < 1000) return "the leading place should be named by 1,000+ articles";
    return null;
  },
});
await call("get_field_distribution", { field: "author", over_time: true }, {
  check: (p) => {
    if (p.items_with_value < 9000) return `signed articles dropped to ${p.items_with_value} (was 9,664)`;
    const years = Object.keys(p.coverage_by_year ?? {});
    if (years.length < 30) return `expected a long byline timeline, got ${years.length} years`;
    return null;
  },
});
await call("get_cooccurrence", { field: "subject", top_n: 8 }, {
  structured: true,
  check: (p) => {
    const m = p.matrix ?? [];
    if (m.length !== 8) return `matrix should be 8x8, got ${m.length}`;
    for (let i = 0; i < m.length; i++) {
      if (m[i][i] !== p.values[i].count) return "diagonal is not each value's own count";
      for (let j = 0; j < m.length; j++) if (m[i][j] !== m[j][i]) return "matrix is not symmetric";
    }
    return null;
  },
});
await call("get_lexical_metrics", { group_by: "country" }, {
  structured: true,
  check: (p) => {
    const g = p.groups?.find((x) => x.group === "Burkina Faso");
    if (!g) return "no Burkina Faso group";
    // Readability 0-100 and MATTR 0-1: a swap or a rescale upstream shows here.
    if (!(g.readability_avg > 30 && g.readability_avg < 90)) return `readability ${g.readability_avg} off-scale`;
    if (!(g.mattr_avg > 0.5 && g.mattr_avg < 1)) return `MATTR ${g.mattr_avg} off-scale`;
    if (g.words_avg < 100) return `words_avg ${g.words_avg} implausibly low`;
    return null;
  },
});
await call("get_place_distribution", { top_n: 40 }, {
  structured: true,
  check: (p) => {
    if (p.items_with_place < 10_000) return `spatial fill dropped to ${p.items_with_place} (was 10,634)`;
    const geo = p.places?.filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lng)) ?? [];
    if (geo.length < 20) return `only ${geo.length} places carry coordinates`;
    // Mecca is among the most-named places in the corpus and sits far outside
    // West Africa: it must arrive geocoded so the view can disclose it rather
    // than draw it at the frame's edge.
    const mecca = p.places.find((x) => x.place === "La Mecque");
    if (!mecca?.lat) return "La Mecque should come back geocoded";
    if (!(p.ungeocoded_mentions > 0)) return "no ungeocoded places reported — the join has stopped missing";
    if (!p.items_by_country?.["Burkina Faso"]) return "per-country totals missing for the choropleth";
    return null;
  },
});
await call("get_semantic_map", { limit: 200, color_by: "country" }, {
  structured: true,
  check: (p, _body, res) => {
    if (p.projected < 150) return `only ${p.projected} of 200 requested items projected`;
    const [a, b] = p.explained_variance ?? [];
    // 768-d text embeddings put ~13-18% in the first two components. Anything
    // near 1 would mean the vectors had collapsed; 0 would mean they are noise.
    if (!(a > 0.02 && a < 0.6)) return `PC1 explains ${a}, outside the plausible band for 768-d embeddings`;
    if (!(b > 0 && b <= a)) return `PC2 explains ${b}, which cannot exceed PC1`;
    // v3.0.0 moved the coordinates out of the model-facing payload and into the
    // chart-only `_meta` channel (src/viewContract.ts). Reading them from `p`
    // still "worked": `p.points?.every(...)` is undefined, which fails the
    // check — so the split reported itself as non-finite coordinates on the
    // first weekly run after it shipped. Read the channel the points are on.
    const points = res._meta?.["islam.zmo.de/viewData"]?.points;
    if (!points?.length) return "no points in _meta, so the chart would render an empty scatter";
    if (points.length !== p.projected) return `_meta has ${points.length} points, projected says ${p.projected}`;
    if (!points.every((x) => Number.isFinite(x.x) && Number.isFinite(x.y))) return "non-finite coordinates";
    return null;
  },
});
// Neighbours of a real article. Also the closest thing this server has to a
// reprint check: a corpus of syndicated West African press should produce at
// least one near-duplicate somewhere in a 20-neighbour sweep.
await call("get_similar_items", { id: "10076", limit: 20 }, {
  structured: true,
  check: (p) => {
    if (p.neighbours?.length !== 20) return `expected 20 neighbours, got ${p.neighbours?.length}`;
    if (p.neighbours.some((n) => n.id === "10076")) return "the source is its own neighbour";
    const scores = p.neighbours.map((n) => n.score);
    if (String(scores) !== String([...scores].sort((a, b) => b - a))) return "neighbours are not sorted by score";
    // Cosine over L2-normalised vectors: anything outside [-1, 1] means the
    // stored vectors are no longer normalised upstream.
    if (scores.some((s) => s > 1.0001 || s < -1.0001)) return `score out of range: ${Math.max(...scores)}`;
    if (scores[0] < 0.5) return `nearest neighbour only ${scores[0]} — the vectors may have changed model`;
    return null;
  },
});
await call("get_similar_items", { id: "999999999" }, {
  expectError: true,
  checkBody: (b) => (b.includes("No articles item") ? null : "an unknown id should say so"),
});
await call("get_sentiment_distribution", { model: "all" }, {
  structured: true,
  check: (p) => {
    if (p.models?.length !== 4) return `expected 4 models, got ${p.models}`;
    const a = p.agreement;
    if (!a) return "no agreement block";
    // 12,298 of 12,349 — the ~51 non-francophone articles are unscored by
    // design, so this is deliberately not asserted equal to total_articles.
    if (a.scored_by_all < 12_000) return `only ${a.scored_by_all} articles scored by all four (was 12,298)`;
    // ~36% unanimous across all four (43% for the first three). A jump to 100%
    // would mean the columns had collapsed onto one another upstream.
    if (a.unanimous_percent < 20 || a.unanimous_percent > 95)
      return `four-model agreement is ${a.unanimous_percent}%, outside the plausible band`;
    // 4 models → 6 unordered pairs. A count of 3 would mean a member is being
    // dropped before the agreement pass.
    if (Object.keys(a.pairwise ?? {}).length !== 6)
      return `expected 6 pairwise counts, got ${JSON.stringify(a.pairwise)}`;
    // The models must be named for what actually ran, and they must be the
    // generation-2 four: a generation-1 id reappearing here means the registry
    // has been re-pointed at columns whose prompt and dtype differ.
    const expected = ["gpt-5-6-luna", "mistral-small-2603", "deepseek-v4-flash-0731", "gemma-4-31b-it"];
    const missing = expected.filter((m) => !p.models.includes(m));
    if (missing.length) return `models should be the exact model ids, missing ${missing} (got ${p.models})`;
    // Subjectivity is an ordinal LABEL in generation 2. A numeric bucket key
    // here would mean the server is reading a generation-1 column.
    const subj = p.by_model?.["gpt-5-6-luna"]?.subjectivity;
    if (!subj?.distribution?.["Plutôt objectif"]) return `subjectivity is not keyed by label: ${JSON.stringify(subj)}`;
    if (subj.mean_rank < 1 || subj.mean_rank > 5) return `mean_rank ${subj.mean_rank} is off the 1-5 ranking`;
    if (!subj.caveat) return "subjectivity must ship its reliability caveat";
    return null;
  },
});
// Vendor shorthand resolves, and answers with the model id.
await call("get_sentiment_distribution", { model: "chatgpt" }, {
  structured: true,
  check: (p) => (p.model === "gpt-5-6-luna" ? null : `vendor alias should resolve to the model id, got ${p.model}`),
});
// The Google slot, whose two handles resolve differently ON PURPOSE: `google`
// is a vendor and lands on that vendor's generation-2 member; `gemini` names a
// model line that only ran generation 1, so it errors rather than being read as
// Gemma. Asserted against the live columns because this is exactly the pair a
// registry edit gets wrong.
await call("get_sentiment_distribution", { model: "google" }, {
  structured: true,
  check: (p) => {
    if (p.model !== "gemma-4-31b-it") return `the google shorthand should resolve to Gemma, got ${p.model}`;
    const dist = p.polarity_distribution ?? {};
    const scored = Object.values(dist).reduce((a, b) => a + b, 0);
    if (scored < 12_000) return `gemma scored only ${scored} articles on polarity (was 12,298)`;
    if (typeof p.subjectivity?.distribution?.["Très objectif"] !== "number")
      return `gemma subjectivity is not keyed by label: ${JSON.stringify(p.subjectivity?.distribution)}`;
    return null;
  },
});
// Generation 1 is dropped: its ids must fail by name rather than answer with
// the same vendor's generation-2 model.
for (const retired of ["gpt-5-mini", "gemini"]) {
  await call("get_sentiment_distribution", { model: retired }, {
    expectError: true,
    checkBody: (b) =>
      b.includes("generation-2") ? null : `${retired} should be refused by name, got: ${b.slice(0, 200)}`,
  });
}
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
// presence/absence of the three semantic tools is asserted against the tools list
// near the top of this script (no call here — that would need a Google API key). ---

// --- error path ----------------------------------------------------------------
await call("get_article", { article_id: 1 }, { expectError: true });

await client.close();
await transport.close();

tokenReport();

console.log(`\n${failures() === 0 ? "ALL CHECKS PASSED" : `${failures()} CHECK(S) FAILED`}`);
process.exitCode = failures() === 0 ? 0 : 1;
