// Headless test for the MCP App chart bundle.
//
// Reads `ui://iwac/charts.html` back out of the BUILT server exactly as a host
// would (resources/read over stdio), then evaluates the inlined script in a
// Node vm behind a minimal DOM shim and drives it through the real MCP Apps
// postMessage handshake. That covers three things nothing else does:
//
//   * the bundle boots — which is the runtime check behind the zod locale
//     stubbing in scripts/bundle.mjs: zod initialises its default error map at
//     module scope, so a stub reached during init would throw right here;
//   * every payload shape renders to SVG, with no CSP-violating markup;
//   * the interactive half works — clicking an action issues the tools/call it
//     claims to, with the filters carried forward.
//
// Run via `npm run test:app`. Requires a prior `npm run build`.
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps";
import * as vm from "node:vm";
import { gunzipSync } from "node:zlib";
import { parseHTML } from "linkedom";
import { withFixtureScope } from "./_fixture-client.mjs";

await withFixtureScope(async (fixtures) => {
  /**
   * Ceiling on the shipped UI resource, which is inlined into server/index.js and
   * therefore rides in every .mcpb and every Docker image.
   *
   * This is a tripwire for a STEP change, not a style guide. ~190 kb of the
   * bundle is one copy of the MCP SDK and zod; a chart is 3-5 kb. So the failure
   * mode worth catching is a second SDK copy landing (a per-chart entry point,
   * docs/mcp-apps-roadmap.md §2.2) or the zod locale stubbing regressing — each
   * worth ~190 kb on its own. The ceiling sits below where either would put it
   * and well above where a dozen more charts would. Raising it is a decision to
   * be argued for, not a formality; the size is printed on every run so ordinary
   * growth stays visible without failing anything.
   */
  const UI_BUDGET_KB = 300;

  let failures = 0;
  const fail = (msg) => {
    failures++;
    console.error(`  FAIL: ${msg}`);
  };

  // --- fetch the resource the way a host does ----------------------------------

  const { client, close: closeClient } = await fixtures.connect({ name: "app-test" });

  const listed = await client.listResources();
  const entry = listed.resources.find((r) => r.uri === "ui://iwac/charts.html");
  if (!entry)
    fail(`ui://iwac/charts.html not registered (got ${listed.resources.map((r) => r.uri).join(", ") || "none"})`);

  const read = await client.readResource({ uri: "ui://iwac/charts.html" });
  const html = read.contents[0]?.text ?? "";
  const mimeType = read.contents[0]?.mimeType;
  if (entry?._meta?.ui?.prefersBorder !== true || read.contents[0]?._meta?.ui?.prefersBorder !== true)
    fail("resource list/read metadata lost the nested MCP Apps border preference");

  // The MIME type is duplicated in src/tools/appUi.ts rather than imported (the
  // server must not depend on ext-apps at runtime). Pin the copy to the real
  // constant so the two cannot drift.
  if (mimeType !== RESOURCE_MIME_TYPE) fail(`resource mimeType ${mimeType}, expected ${RESOURCE_MIME_TYPE}`);
  if (!html.includes("<!DOCTYPE html>")) fail("UI resource is not an HTML document");
  if (html.includes("run `npm run build`")) fail("UI fell back to the dev placeholder — rebuild before testing");

  const sizeKb = Buffer.byteLength(html) / 1024;
  if (sizeKb > UI_BUDGET_KB) fail(`UI resource is ${sizeKb.toFixed(1)}kb, over the ${UI_BUDGET_KB}kb budget`);
  else console.log(`  ui resource ${sizeKb.toFixed(1)}kb / ${UI_BUDGET_KB}kb budget`);

  await closeClient();

  // --- CSP: nothing may be fetched ---------------------------------------------

  for (const [what, re] of [
    ["a remote script/style", /<(?:script|link)[^>]+(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i],
    ["a remote image", /<img[^>]+src\s*=\s*["']?(?:https?:)?\/\//i],
    ["@import", /@import\s/i],
    ["a webfont", /@font-face/i],
  ]) {
    if (re.test(html)) fail(`UI resource loads ${what}; it must be fully self-contained`);
  }

  // --- DOM shim -----------------------------------------------------------------

  // A real DOM is essential: selectors and SVG click/keyboard listeners must
  // actually run, rather than silently wiring an empty element list.
  const dom = parseHTML(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ""));
  const rootEl = dom.document.getElementById("root");
  const elements = { get: (id) => dom.document.getElementById(id) };
  const outbound = [];
  let messageListener = null;

  const documentElement = dom.document.documentElement;
  documentElement.getBoundingClientRect = () => ({ height: 400, width: 900 });
  dom.document.body.getBoundingClientRect = () => ({ height: 400, width: 900 });

  const parent = {
    postMessage(msg) {
      outbound.push(msg);
    },
  };

  const windowShim = {
    parent,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener(type, fn) {
      if (type === "message") messageListener = fn;
    },
    removeEventListener() {},
    innerWidth: 900,
  };

  const sandbox = {
    window: windowShim,
    document: dom.document,
    MouseEvent: dom.window.Event,
    // `debug` is noisy (the transport logs every frame); warnings and errors are
    // exactly the signal a broken app emits, so they must not be swallowed.
    console: {
      log() {},
      debug() {},
      warn: (...a) => console.warn("  [app warn]", ...a),
      error: (...a) => console.error("  [app error]", ...a),
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: (fn) => fn(),
    setTimeout,
    clearTimeout,
    URL,
    TextEncoder,
    TextDecoder,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = windowShim;

  // Chromium covers the actual DecompressionStream bootstrap under CSP. The
  // fast DOM harness executes the exact decompressed shipped script.
  const compressed = /<script id="iwac-chart-bundle" type="application\/gzip">([^<]+)<\/script>/.exec(html);
  const script = compressed ? gunzipSync(Buffer.from(compressed[1], "base64")).toString("utf8")
    : html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
  const decodedKb = Buffer.byteLength(script) / 1024;
  if (decodedKb > 500) fail(`decoded UI script is ${decodedKb.toFixed(1)}kb, over the 500kb duplicate-dependency guard`);
  console.log(`  decoded UI script ${decodedKb.toFixed(1)}kb / 500kb budget`);
  if (!script.trim()) fail("no inline script found in the UI resource");

  // This is the zod-locale-stub smoke check: the IIFE runs zod's module
  // initialisation, the App constructor and z.config() as it evaluates.
  try {
    vm.runInNewContext(script, sandbox, { filename: "charts.js" });
  } catch (err) {
    fail(`the app bundle threw while booting: ${err.stack}`);
    throw err;
  }

  // --- handshake ----------------------------------------------------------------

  const deliver = (msg) => messageListener?.({ data: msg, source: parent });
  const take = (predicate) => outbound.find(predicate);
  const flush = () => new Promise((r) => setImmediate(r));

  await flush();
  const init = take((m) => m.method === "ui/initialize");
  if (!init) fail("the app did not send ui/initialize");
  else {
    deliver({
      jsonrpc: "2.0",
      id: init.id,
      result: {
        protocolVersion: init.params.protocolVersion,
        hostInfo: { name: "test-host", version: "0.0.0" },
        hostCapabilities: { serverTools: {}, downloadFile: {}, openLinks: {} },
        hostContext: { theme: "dark" },
      },
    });
    await flush();
    if (documentElement.getAttribute("data-theme") !== "dark")
      fail(`app ignored the host theme (data-theme=${documentElement.getAttribute("data-theme")})`);
  }

  // --- render each payload shape ------------------------------------------------

  /**
   * Push a tool result at the app the way a host does, and return the markup.
   *
   * `viewData`, when given, rides in `_meta` under the view-data key instead of in
   * the model-visible halves, the split `viewResult` performs for chart-heavy
   * tools. The host forwards `_meta` to the view untouched (the MCP Apps spec
   * types the tool-result notification's params as a whole `CallToolResult`),
   * which is exactly what this reproduces.
   */
  async function renderPayload(payload, viewData = null, provenance = null) {
    outbound.length = 0;
    deliver({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
        ...(viewData || provenance ? { _meta: {
          ...(viewData ? { "islam.zmo.de/viewData": viewData } : {}),
          ...(provenance ? { "islam.zmo.de/provenance": provenance } : {}),
        } } : {}),
      },
    });
    await flush();
    await flush();
    return rootEl.innerHTML;
  }

  /** Assertions every rendered view must satisfy. */
  function checkMarkup(name, markup) {
    if (!markup.includes("<svg")) fail(`${name}: rendered no SVG — ${markup.slice(0, 200)}`);
    if (/\son[a-z]+\s*=/i.test(markup)) fail(`${name}: rendered an inline event handler (blocked under CSP)`);
    if (/<script/i.test(markup)) fail(`${name}: rendered a <script> tag`);
    if (/https?:\/\//i.test(markup)) fail(`${name}: rendered an absolute URL`);
    if (markup.includes("has no view named")) fail(`${name}: the bundle has no view registered for this payload`);
    if (markup.includes("Could not draw")) fail(`${name}: the view threw — ${markup.slice(0, 300)}`);
  }

  const CASES = [];

  CASES.push([
    "temporal (flat)",
    {
      view: "temporal",
      subset: "articles",
      granularity: "year",
      filters: { keyword: "charia" },
      total_matches: 120,
      dated_count: 118,
      undated_count: 2,
      distribution: { 1998: 10, 1999: 40, 2000: 68 },
    },
    (markup) => {
      if (!markup.includes("1998")) return "missing an x-axis label";
      if (!markup.includes("keyword: charia")) return "missing the filter chip";
      if (!markup.includes("carry no usable date")) return "did not disclose the undated items";
      return null;
    },
  ]);

  CASES.push([
    "temporal (grouped)",
    {
      view: "temporal",
      subset: "articles",
      granularity: "month",
      group_by: "country",
      filters: {},
      total_matches: 6,
      dated_count: 6,
      undated_count: 0,
      distribution_by_group: { Benin: { "2001-01": 2, "2001-02": 1 }, Togo: { "2001-02": 3 } },
    },
    (markup) => {
      if (!markup.includes("legend")) return "grouped chart drew no legend";
      if (!markup.includes("Benin")) return "legend is missing a group";
      return null;
    },
  ]);

  CASES.push([
    "periodicals",
    {
      view: "periodicals",
      total_periodicals: 3,
      periodicals: [
        { newspaper: "Islam Info", country: "Burkina Faso", issue_count: 695, earliest_year: 2005, latest_year: 2020 },
        {
          newspaper: "An-Nasr Vendredi",
          country: "Burkina Faso",
          issue_count: 318,
          earliest_year: 1998,
          latest_year: 2012,
        },
        // No year range: must be disclosed, not silently dropped.
        { newspaper: "Sans dates", country: "Togo", issue_count: 4 },
      ],
    },
    (markup) => {
      if (!markup.includes("Islam Info")) return "missing a series label";
      if (!markup.includes("695")) return "issue count is not in the tooltip";
      if (!markup.includes("1 series carry no usable year")) return "undated series were not disclosed";
      return null;
    },
  ]);

  CASES.push([
    "countries",
    {
      view: "countries",
      total_countries: 2,
      polarity_model: "gpt-5-6-luna",
      countries: [
        {
          country: "Burkina Faso",
          article_count: 4000,
          newspaper_count: 12,
          date_range: { earliest: "1990-01-01", latest: "2020-12-31" },
          polarity: { Positif: 1000, Neutre: 2000, Négatif: 1000 },
        },
        { country: "Togo", article_count: 900, newspaper_count: 5 },
      ],
    },
    (markup) => {
      if (!markup.includes("Burkina Faso")) return "missing a country";
      if (!markup.includes("Polarity mix per country")) return "polarity panel did not render";
      // The chart must name the model that judged, not just "AI".
      if (!markup.includes("gpt-5-6-luna")) return "polarity chart did not name its model";
      if (!markup.includes("Polarity shown for 1 of 2")) return "did not disclose partial polarity coverage";
      return null;
    },
  ]);

  CASES.push([
    "newspapers",
    {
      view: "newspapers",
      total_newspapers: 30,
      total_articles: 1000,
      newspapers: Array.from({ length: 30 }, (_, i) => ({
        newspaper: `Journal ${i}`,
        country: "Benin",
        article_count: 100 - i,
      })),
    },
    (markup) => {
      if (!markup.includes("Journal 0")) return "missing the top title";
      if (markup.includes("Journal 29")) return "drew past the top-N cap";
      if (!markup.includes("Showing the top 25 of 30")) return "capped the list without saying so";
      return null;
    },
  ]);

  CASES.push([
    "sentiment",
    {
      view: "sentiment",
      model: "gpt-5-6-luna",
      total_articles: 120,
      filters: { country: "Niger" },
      polarity_distribution: { Neutre: 60, "Très négatif": 20, Positif: 20 },
      centrality_distribution: { Central: 50, Marginal: 50 },
      subjectivity: {
        scale:
          "Très objectif | Plutôt objectif | Mixte | Plutôt subjectif | Très subjectif (ordinal, least to most subjective)",
        scored: 100,
        unscored: 20,
        distribution: {
          "Très objectif": 40,
          "Plutôt objectif": 30,
          Mixte: 10,
          "Plutôt subjectif": 15,
          "Très subjectif": 5,
        },
        mean_rank: 2.15,
        median_rank: 2,
        rank_scale: "1 = Très objectif … 5 = Très subjectif; derived here, not stored",
        caveat: "Weakest of the three scales: inter-model agreement κ 0.16-0.52.",
      },
    },
    (markup) => {
      if ((markup.match(/<svg/g) ?? []).length < 3) return "expected a donut for each of the three vocabularies";
      // Ordinal order, not alphabetical: Positif must precede Neutre.
      if (markup.indexOf("Positif") > markup.indexOf("Neutre")) return "polarity slices are not in scale order";
      if (markup.indexOf("Très objectif") > markup.indexOf("Plutôt subjectif"))
        return "subjectivity slices are not in scale order";
      if (!markup.includes("20 matching articles carry no gpt-5-6-luna score"))
        return "did not reconcile scored vs matched";
      // The chart is the easiest thing here to quote out of context, so the
      // weakness of the scale has to travel with it.
      if (!markup.includes("κ 0.16-0.52")) return "subjectivity caveat missing from the chart";
      if (!markup.includes("mean rank 2.15")) return "derived rank not disclosed as derived";
      return null;
    },
  ]);

  CASES.push([
    "collection",
    {
      view: "collection",
      collection_name: "Islam West Africa Collection (IWAC)",
      subset_counts: { articles: 12287, publications: 1501, index: 4854, images: 30 },
      total_records: 18672,
      fulltext_coverage: { articles: { with_fulltext: 7480, total: 12287, percent: 61 } },
      fulltext_note: "This is the PUBLIC dataset: full text (OCR) ships only for public items.",
      newspaper_count: 118,
    },
    (markup) => {
      if (!markup.includes("articles")) return "missing a treemap cell";
      if (!markup.includes("61%")) return "full-text gauge did not render the share";
      if (!markup.includes("PUBLIC dataset")) return "dropped the full-text caveat";
      return null;
    },
  ]);

  CASES.push([
    "topics",
    {
      view: "topics",
      subset: "articles",
      filters: {},
      total_matches: 12287,
      classified: 12234,
      topics: [
        {
          topic_id: 12,
          label: "imam - mosquée - communauté_musulman - prière - fidèle - hadj",
          count: 1989,
          avg_prob: 0.347,
        },
        {
          topic_id: 7,
          label: "religieux - politique - etat - question - communauté - religion",
          count: 1251,
          avg_prob: 0.318,
        },
      ],
      periods: ["1999", "2000"],
      series_by_topic: {
        "imam - mosquée - communauté_musulman - prière - fidèle - hadj": { 1999: 10, 2000: 20 },
        "(other topics)": { 1999: 5, 2000: 8 },
      },
    },
    (markup) => {
      // Six-term LDA labels must be shortened for the cells but kept in full in
      // the tooltip, which is the only place the whole label survives.
      if (!markup.includes("imam · mosquée · communauté musulman…")) return "LDA label was not shortened for display";
      if (!markup.includes("communauté_musulman - prière - fidèle - hadj"))
        return "full label missing from the tooltip";
      if (!markup.includes("(other topics)")) return "the residual band did not render";
      return null;
    },
  ]);

  CASES.push([
    "field (bylines)",
    {
      view: "field",
      subset: "articles",
      field: "author",
      filters: {},
      total_matches: 12287,
      items_with_value: 9664,
      distinct_values: 2463,
      values: [
        { value: "Agence Togolaise de Presse", count: 272 },
        { value: "Diaby Salif", count: 181 },
      ],
      other_values: 2461,
      coverage_by_year: { 1970: { total: 48, with_value: 15 }, 1971: { total: 36, with_value: 7 } },
    },
    (markup) => {
      if (!markup.includes("Bylines")) return "field title not mapped";
      if (!markup.includes("Agence Togolaise de Presse")) return "missing a ranked value";
      if (!markup.includes("2 461 further values")) return "did not disclose the untruncated remainder";
      if (!markup.includes("31.3%")) return "coverage share panel did not render a percentage";
      return null;
    },
  ]);

  CASES.push([
    "cooccurrence",
    {
      view: "cooccurrence",
      subset: "articles",
      field: "subject",
      filters: {},
      total_matches: 12287,
      values: [
        { value: "Prière", count: 2139 },
        { value: "Hadj", count: 1917 },
        { value: "Paix", count: 1894 },
      ],
      matrix: [
        [2139, 354, 796],
        [354, 1917, 214],
        [796, 214, 1894],
      ],
      top_pairs: [
        { a: "Prière", b: "Paix", count: 796 },
        { a: "Prière", b: "Hadj", count: 354 },
      ],
    },
    (markup) => {
      if (!markup.includes("Prière × Paix: 796")) return "matrix cell tooltip missing";
      // The diagonal is blanked, so a 3x3 matrix draws 6 cells, not 9.
      const cells = (markup.match(/Prière × Prière/g) ?? []).length;
      if (cells !== 0) return "the diagonal should be blanked out of the heatmap";
      if (!markup.includes("Prière + Paix")) return "top-pairs chart missing";
      return null;
    },
  ]);

  CASES.push([
    "lexical",
    {
      view: "lexical",
      group_by: "country",
      filters: {},
      total_matches: 12287,
      groups: [
        {
          group: "Côte d'Ivoire",
          items: 3994,
          readability_avg: 65.23,
          readability_n: 3993,
          mattr_avg: 0.815,
          words_avg: 621,
        },
        {
          group: "Burkina Faso",
          items: 3659,
          readability_avg: 63.15,
          readability_n: 3659,
          mattr_avg: 0.811,
          words_avg: 758,
        },
      ],
      metrics: { mattr: { label: "Lexical richness (MATTR)" } },
      readability_excluded: 9,
    },
    (markup) => {
      if (!markup.includes("Readability")) return "readability panel missing";
      if (!markup.includes("0.815")) return "MATTR value not rendered at full precision";
      if (!markup.includes("9 non-French items are excluded")) return "did not disclose the readability exclusion";
      if (!markup.includes("already length-robust")) return "dropped the MATTR normalisation warning";
      return null;
    },
  ]);

  CASES.push([
    "sentiment (five models)",
    {
      view: "sentiment",
      model: "all",
      // Real generation-2 figures, measured over the 12,098 articles all five
      // models scored (2026-08-25 revision), so a rendering change that mangles
      // the numbers is visible as a wrong-looking chart rather than a plausible
      // one. Note what each new member did to the headline: unanimity on polarity
      // fell 43% → 36% with the fourth and 36% → 32% with the fifth. The fifth
      // also breaks the panel's uniform coverage, which is why the blocks below
      // carry `coverage` — qwen is measured on 200 fewer articles than the rest.
      total_articles: 12349,
      filters: {},
      models: ["gpt-5-6-luna", "mistral-small-2603", "deepseek-v4-flash-0731", "gemma-4-31b-it", "qwen3-8-27b"],
      by_model: {
        "gpt-5-6-luna": {
          polarity_distribution: {
            Positif: 6146,
            Neutre: 5017,
            "Très positif": 425,
            Négatif: 375,
            "Non applicable": 290,
            "Très négatif": 45,
          },
          subjectivity: {
            scale:
              "Très objectif | Plutôt objectif | Mixte | Plutôt subjectif | Très subjectif (ordinal, least to most subjective)",
            scored: 12008,
            unscored: 341,
            distribution: {
              "Très objectif": 1144,
              "Plutôt objectif": 7900,
              Mixte: 314,
              "Plutôt subjectif": 1914,
              "Très subjectif": 736,
            },
            mean_rank: 2.434,
            median_rank: 2,
            rank_scale: "1 = Très objectif … 5 = Très subjectif; derived here, not stored",
            caveat: "Weakest of the three scales: inter-model agreement κ 0.16-0.52.",
          },
          coverage: { polarity: 12298, centrality: 12298, subjectivity: 12008, matched_articles: 12349 },
        },
        "mistral-small-2603": {
          polarity_distribution: {
            Positif: 4985,
            Neutre: 4093,
            "Très positif": 2087,
            "Non applicable": 587,
            Négatif: 362,
            "Très négatif": 184,
          },
          coverage: { polarity: 12298, matched_articles: 12349 },
        },
        "deepseek-v4-flash-0731": {
          polarity_distribution: {
            Neutre: 6649,
            Positif: 4001,
            "Très positif": 900,
            "Non applicable": 484,
            Négatif: 223,
            "Très négatif": 41,
          },
          coverage: { polarity: 12298, matched_articles: 12349 },
        },
        "gemma-4-31b-it": {
          polarity_distribution: {
            Neutre: 7275,
            Positif: 3871,
            "Très positif": 627,
            "Non applicable": 243,
            Négatif: 233,
            "Très négatif": 49,
          },
          coverage: { polarity: 12298, matched_articles: 12349 },
        },
        // The short member. It also barely uses the extremes — 176 Très positif
        // against Luna's 425, and 5 Très négatif — so its ring is a real shape,
        // not a copy of its neighbour's.
        "qwen3-8-27b": {
          polarity_distribution: {
            Neutre: 6298,
            Positif: 5107,
            "Non applicable": 288,
            Négatif: 224,
            "Très positif": 176,
            "Très négatif": 5,
          },
          coverage: { polarity: 12098, matched_articles: 12349 },
          model_caveat: "Scores 12,098 articles where the other four score 12,298.",
        },
      },
      agreement: {
        field: "polarity",
        scored_by_all: 12098,
        unanimous: 3929,
        unanimous_percent: 32,
        pairwise: {
          "gpt-5-6-luna~mistral-small-2603": 7019,
          "gpt-5-6-luna~deepseek-v4-flash-0731": 8277,
          "gpt-5-6-luna~gemma-4-31b-it": 8470,
          "gpt-5-6-luna~qwen3-8-27b": 8874,
          "mistral-small-2603~deepseek-v4-flash-0731": 6605,
          "mistral-small-2603~gemma-4-31b-it": 6128,
          "mistral-small-2603~qwen3-8-27b": 6502,
          "deepseek-v4-flash-0731~gemma-4-31b-it": 9064,
          "deepseek-v4-flash-0731~qwen3-8-27b": 8607,
          "gemma-4-31b-it~qwen3-8-27b": 9056,
        },
        base: "articles scored on polarity by all 5 models (of 12349 matched)",
        base_caveats: { "qwen3-8-27b": "Scores 12,098 articles where the other four score 12,298." },
      },
      // Measured alongside the rest. Note it decides MORE articles (11,869) than
      // the agreement base holds (12,098 scored by all five, of which 3,929 are
      // unanimous): the two count different things on different sets, which is
      // exactly what the chart has to keep apart.
      consensus: {
        polarity_distribution: {
          Neutre: 5985,
          Positif: 4838,
          "Très positif": 483,
          "Non applicable": 323,
          Négatif: 211,
          "Très négatif": 29,
        },
        centrality_distribution: {
          "Très central": 8247,
          Central: 1236,
          Marginal: 1166,
          Secondaire: 871,
          "Non abordé": 313,
        },
        coverage: { polarity: 11869, centrality: 11833, subjectivity: 12195, matched_articles: 12349 },
        disputed: { polarite: 429, centralite: 465, subjectivite: 3184, any: 3778 },
      },
      agreement_matrix: {
        rows: "gpt-5-6-luna",
        cols: "mistral-small-2603",
        counts: {
          Négatif: { Négatif: 128, Neutre: 137, "Très négatif": 65, Positif: 34 },
          Neutre: { Neutre: 2913, Positif: 1406, "Non applicable": 309 },
        },
      },
    },
    (markup) => {
      // Count-driven, so a sixth member changes the heading instead of making it
      // wrong — the title said "three models" over four rings until v3.2.0.
      if (!markup.includes("5 models compared")) return "did not switch to the comparison view";
      if (!markup.includes("32%")) return "agreement rate missing from the headline";
      if (!markup.includes("gpt-5-6-luna ↔ mistral-small-2603")) return "pairwise agreement chart missing";
      if (!markup.includes("deepseek-v4-flash-0731 ↔ gemma-4-31b-it")) return "the fourth model's pairs are missing";
      if (!markup.includes("gemma-4-31b-it ↔ qwen3-8-27b")) return "the fifth model's pairs are missing";
      if (!markup.includes("all 5")) return "the unanimity bar should name the panel size";
      // The uneven coverage must reach the CHART, not only the JSON: a ring drawn
      // on 200 fewer articles than the one beside it is a misreading waiting to
      // happen, and the four complete members must stay unannotated.
      if (!markup.includes("200 fewer articles scored")) return "the short member's ring is not captioned";
      if ((markup.match(/fewer articles scored/g) ?? []).length !== 1)
        return "only the short member's ring should be captioned";
      // The consensus must render, and must NOT read as a sixth annotator: it sits
      // in its own panel and the note says outright that no model produced it.
      if (!markup.includes("Panel consensus")) return "the panel's conclusion is missing from the comparison";
      if (!markup.includes("No model produced it")) return "the consensus must disclaim being a model";
      // Digit groups use THOUSANDS_SEP, which is a space rather than a comma, so
      // these match the separator loosely instead of hard-coding it.
      if (!/11\D?869/.test(markup)) return "the consensus should state its own base, not borrow the agreement one";
      if (!/subjectivite 3\D?184/.test(markup)) return "the split-panel breakdown is missing";
      // The agreeing diagonal is blanked so the ramp covers the disagreements.
      if (markup.includes("Négatif × Négatif")) return "the agreeing diagonal should be blanked";
      if (!markup.includes("Négatif × Neutre: 137")) return "confusion cell missing";
      return null;
    },
  ]);

  CASES.push([
    "places",
    {
      view: "places",
      subset: "articles",
      filters: {},
      total_matches: 12287,
      items_with_place: 10634,
      items_by_country: { "Côte d'Ivoire": 3994, "Burkina Faso": 3659, Benin: 2003 },
      places: [
        // Country-level, geocoded to a centroid: must NOT become a bubble.
        { place: "Côte d'Ivoire", count: 2761, lat: 8, lng: -5.5 },
        { place: "Ouagadougou", count: 1624, lat: 12.36566, lng: -1.53388 },
        { place: "Lomé", count: 406, lat: 6.13, lng: 1.22 },
        // Outside the West African frame: counted and disclosed, never drawn.
        { place: "La Mecque", count: 1649, lat: 21.4225, lng: 39.826111 },
      ],
      ungeocoded: [{ place: "Riviera Golf", count: 153 }],
      ungeocoded_mentions: 1497,
    },
    (markup) => {
      if ((markup.match(/<circle/g) ?? []).length !== 2) return "expected exactly the two in-frame settlements";
      if (/<circle[^>]*><title>Côte d'Ivoire:/.test(markup)) return "a country was drawn as a bubble";
      if (!markup.includes("Named at country level")) return "country-level panel missing";
      if (!markup.includes("La Mecque (off map)")) return "off-frame place not surfaced in the ranking";
      if (!markup.includes("Riviera Golf (not geocoded)")) return "ungeocoded place not surfaced";
      if (!markup.includes("1 geocoded place falls outside")) return "off-frame count not disclosed";
      if (!markup.includes("Natural Earth")) return "basemap provenance missing";
      return null;
    },
  ]);

  CASES.push([
    "semantic map (weak projection)",
    {
      view: "semanticMap",
      subset: "articles",
      filters: {},
      total_matches: 12287,
      projected: 300,
      color_by: "country",
      // 18% is the real figure for 768-d article embeddings; the view must say
      // so rather than let the reader take the distances at face value.
      explained_variance: [0.1349, 0.0466],
      points: Array.from({ length: 300 }, (_, i) => ({
        id: String(i),
        title: `Article ${i}`,
        group: ["Benin", "Togo", "Niger"][i % 3],
        x: Math.cos(i) * 0.3,
        y: Math.sin(i) * 0.2,
      })),
      note: "PCA over 768-dimension embeddings.",
    },
    (markup) => {
      if ((markup.match(/<circle/g) ?? []).length !== 300) return "not every point was drawn";
      if (!markup.includes("18.1%")) return "explained variance missing from the headline";
      if (!markup.includes("distances here are a weak signal")) return "a weak projection must be flagged as such";
      if (!markup.includes("This is PCA, not UMAP")) return "missing the UMAP disclaimer";
      return null;
    },
  ]);

  CASES.push([
    "similar items",
    {
      view: "similar",
      subset: "articles",
      source: { id: "10076", title: "Tabaski 2018 : 800 bœufs abattus", url: "https://islam.zmo.de/x" },
      neighbours: [
        {
          id: "2374",
          title: "Fête de la tabaski : 832 bœufs",
          score: 0.8747,
          newspaper: "Sidwaya",
          pub_date: "2018-08-23",
        },
        { id: "4018", title: "Tabaski 2018 : l'ONG FOSAPA solidaire", score: 0.8225, newspaper: "L'Observateur" },
        { id: "3428", title: "Tabaski 2017 : tolérance religieuse", score: 0.6979, newspaper: "Sidwaya" },
      ],
      note: "Cosine similarity over the stored embeddings; 1.0 is identical.",
    },
    (markup) => {
      if (!markup.includes("0.875")) return "scores should render at 3 decimals";
      if (!markup.includes("3 neighbours")) return "neighbour count missing";
      if (!markup.includes("not evidence of copying")) return "missing the interpretation caution";
      // The above-threshold bar is coloured differently so the cliff is visible.
      if (!markup.includes('data-key="2374"')) return "stable source ID missing";
      return null;
    },
  ]);

  CASES.push([
    "temporal (empty)",
    {
      view: "temporal",
      subset: "documents",
      granularity: "year",
      filters: { keyword: "zzzz" },
      total_matches: 0,
      dated_count: 0,
      undated_count: 0,
      distribution: {},
    },
    null, // no SVG expected; checked separately below
  ]);

  for (const [name, payload, extra] of CASES) {
    const markup = await renderPayload(payload);
    if (name.endsWith("(empty)")) {
      if (!markup.includes("No dated items")) fail(`${name}: no empty-state message`);
      continue;
    }
    checkMarkup(name, markup);
    const msg = extra?.(markup);
    if (msg) fail(`${name}: ${msg}`);
  }

  // An unknown view must say so rather than render a blank panel.
  {
    const markup = await renderPayload({ view: "not-a-real-view", x: 1 });
    if (!markup.includes("has no view named")) fail("unknown view did not produce a diagnostic");
  }

  // --- model/view payload split --------------------------------------------------
  // Chart-heavy tools send the model a summary and the chart the full series, the
  // series travelling in `_meta` (src/viewContract.ts). The charts must come out
  // pixel-identical either way. If a view silently degrades when its data arrives
  // through `_meta`, the split has cost the user the thing it was protecting.
  {
    const points = Array.from({ length: 300 }, (_, i) => ({
      id: String(i),
      title: `Article ${i}`,
      group: ["Benin", "Togo", "Niger"][i % 3],
      x: Math.cos(i) * 0.3,
      y: Math.sin(i) * 0.2,
    }));
    const modelHalf = {
      view: "semanticMap",
      subset: "articles",
      filters: {},
      total_matches: 12287,
      projected: 300,
      color_by: "country",
      groups: { Benin: 100, Togo: 100, Niger: 100 },
      explained_variance: [0.1349, 0.0466],
      note: "PCA over 768-dimension embeddings.",
    };

    const split = await renderPayload(modelHalf, { points });
    checkMarkup("semantic map (split)", split);
    if ((split.match(/<circle/g) ?? []).length !== 300) {
      fail("semantic map (split): points arriving via _meta were not all drawn");
    }

    // Same data, old shape: the merge must be additive, not a replacement.
    const inline = await renderPayload({ ...modelHalf, points });
    if (split !== inline) fail("semantic map: the _meta split rendered differently from the inline payload");

    // Without the _meta half there is no series at all, proof the chart really is
    // reading `_meta` here and not quietly falling back to something else.
    const starved = await renderPayload(modelHalf);
    if ((starved.match(/<circle/g) ?? []).length !== 0) {
      fail("semantic map: drew points with no series in either half");
    }

    // Same for the topics band chart, whose split is partial: `topics` stays with
    // the model, only the per-year matrix moves.
    const topicsModel = {
      view: "topics",
      subset: "articles",
      filters: {},
      total_matches: 12287,
      classified: 12234,
      topics: [
        {
          topic_id: 12,
          label: "imam - mosquée - communauté_musulman - prière - fidèle - hadj",
          count: 1989,
          avg_prob: 0.347,
        },
      ],
      span: ["1999", "2000"],
      trend_by_topic: {
        "imam - mosquée - communauté_musulman - prière - fidèle - hadj": {
          total: 30,
          first: "1999",
          last: "2000",
          peak_year: "2000",
          peak_count: 20,
          median_year: "2000",
        },
      },
    };
    const topicsView = {
      periods: ["1999", "2000"],
      series_by_topic: {
        "imam - mosquée - communauté_musulman - prière - fidèle - hadj": { 1999: 10, 2000: 20 },
        "(other topics)": { 1999: 5, 2000: 8 },
      },
    };
    const topicsSplit = await renderPayload(topicsModel, topicsView);
    checkMarkup("topics (split)", topicsSplit);
    if (!topicsSplit.includes("(other topics)")) fail("topics (split): the residual band did not render from _meta");
  }

  // --- interactivity ------------------------------------------------------------

  const BASE = {
    view: "temporal",
    subset: "articles",
    granularity: "year",
    filters: { country: "Togo", keyword: "laïcité" },
    total_matches: 5,
    dated_count: 5,
    undated_count: 0,
    distribution: { 2003: 5 },
  };

  /** Click an action and return the request it produced, without answering it. */
  async function press(id, method = "tools/call") {
    const button = elements.get(id);
    if (!button) {
      fail(`no ${id} button rendered`);
      return null;
    }
    outbound.length = 0;
    button.click();
    await flush();
    const request = take((m) => m.method === method);
    if (!request) fail(`${id} issued no ${method}`);
    return request;
  }

  /** Answer an in-flight tools/call so the app's await settles. */
  async function answer(request, payload, isError = false) {
    deliver({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        ...(isError ? { isError: true } : { structuredContent: payload }),
      },
    });
    await flush();
    await flush();
  }

  await renderPayload(BASE);

  {
    const call = await press("act-gran");
    if (call) {
      if (call.params.name !== "get_temporal_distribution") fail(`clicked the wrong tool: ${call.params.name}`);
      if (call.params.arguments.granularity !== "month") fail("granularity toggle did not switch to month");
      if (call.params.arguments.country !== "Togo") fail("granularity toggle dropped the country filter");
      if (call.params.arguments.keyword !== "laïcité") fail("granularity toggle dropped the keyword filter");
      await answer(call, { ...BASE, granularity: "month", distribution: { "2003-04": 5 } });
      if (!rootEl.innerHTML.includes("articles per month")) fail("the re-call result did not re-render");
    }
  }

  await renderPayload(BASE);

  {
    const call = await press("act-group");
    if (call && call.params.arguments.group_by !== "country")
      fail("group_by toggle did not request a country grouping");
    // A rejected re-call must keep the chart on screen rather than blanking it:
    // a group_by the subset cannot serve should not cost the user their place.
    if (call) {
      await answer(call, { error: "group_by 'country' is not available for subset 'documents'" }, true);
      const markup = rootEl.innerHTML;
      if (!markup.includes("not available")) fail("a rejected re-call did not surface its error");
      if (!markup.includes("<svg")) fail("a rejected re-call blanked the chart instead of keeping it");
    }
  }

  // A view option switches the rendering with NO server round trip: the network
  // is a second reading of the co-occurrence payload already on screen.
  {
    await renderPayload({
      view: "cooccurrence",
      subset: "articles",
      field: "subject",
      filters: {},
      total_matches: 12287,
      values: [
        { value: "Prière", count: 2139 },
        { value: "Hadj", count: 1917 },
        { value: "Paix", count: 1894 },
      ],
      matrix: [
        [2139, 354, 796],
        [354, 1917, 214],
        [796, 214, 1894],
      ],
      top_pairs: [{ a: "Prière", b: "Paix", count: 796 }],
    });
    if (rootEl.innerHTML.includes("Co-mention network")) fail("the matrix should be the default rendering");

    outbound.length = 0;
    elements.get("act-layout")?.click();
    await flush();
    if (take((m) => m.method === "tools/call")) fail("switching layout must not call the server");
    const markup = rootEl.innerHTML;
    if (!markup.includes("Co-mention network")) fail("the layout toggle did not switch to the network");
    if ((markup.match(/<circle/g) ?? []).length !== 3) fail("expected one node per value");
    if (!markup.includes("NOT a layout of")) fail("the network must disclose that it covers only the top values");

    // And back again, so the option is a toggle rather than a one-way door.
    elements.get("act-layout")?.click();
    await flush();
    if (rootEl.innerHTML.includes("Co-mention network")) fail("the layout toggle did not switch back");
  }

  // A different view must not inherit the previous one's options.
  await renderPayload(BASE);
  if (rootEl.innerHTML.includes("Co-mention network")) fail("view options leaked across a view change");

  // The CSV action only appears when the host advertised downloadFile — which
  // this harness did.
  {
    const call = await press("act-csv", "ui/download-file");
    if (call) {
      const text = call.params.contents[0]?.resource?.text ?? "";
      if (!text.startsWith("year,count")) fail(`CSV header is ${JSON.stringify(text.slice(0, 40))}`);
      if (!text.includes("2003,5")) fail("CSV is missing a data row");
      deliver({ jsonrpc: "2.0", id: call.id, result: {} });
      await flush();
      if (elements.get("act-csv")?.disabled || elements.get("act-csv")?.textContent !== "Download CSV")
        fail("successful CSV download left its action disabled or busy");
      const repeat = await press("act-csv", "ui/download-file");
      if (repeat) { deliver({ jsonrpc: "2.0", id: repeat.id, result: {} }); await flush(); }
    }
  }

  // The regressions below drive real SVG marks through the bundled app and
  // inspect the host protocol, including keyboard activation and stale calls.
  {
    const filters = {
      country: "Benin",
      date_from: "2000",
      keyword: "imam",
      exact: { language: ["Français"] },
      min_prob: 0.6,
    };
    await renderPayload({
      view: "topics",
      subset: "articles",
      filters,
      total_matches: 4,
      classified: 4,
      topics: [
        { topic_id: 7, label: "imam - mosquée - prière - a", count: 2 },
        { topic_id: 8, label: "imam - mosquée - prière - b", count: 2 },
      ],
    });
    const mark = rootEl.querySelector('[data-key="8"]');
    if (mark?.getAttribute("tabindex") !== "0") fail("topic mark missing or inaccessible");
    outbound.length = 0;
    const key = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
    key.key = "Enter";
    mark?.dispatchEvent(key);
    await flush();
    const call = take((m) => m.method === "tools/call");
    if (
      call?.params.arguments.exact?.topic_id?.[0] !== "8" ||
      call.params.arguments.keyword !== "imam" ||
      call.params.arguments.country !== "Benin" ||
      call.params.arguments.date_from !== "2000" ||
      call.params.arguments.exact?.min_prob?.[0] !== "0.6"
    )
      fail("topic activation lost its exact ID or parent scope");
    if (call) await answer(call, BASE);
    elements.get("act-back")?.click();
    await flush();
    if (!rootEl.querySelector('[data-key="8"]')) fail("Back lost the source chart");
  }
  {
    await renderPayload({
      view: "cooccurrence",
      subset: "articles",
      field: "spatial",
      filters: { country: "Benin", date_from: "2000" },
      values: [
        { value: "Lomé", count: 2 },
        { value: "Cotonou", count: 2 },
      ],
      matrix: [
        [2, 1],
        [1, 2],
      ],
    });
    outbound.length = 0;
    rootEl.querySelector('[data-key="Lomé"][data-key2="Cotonou"]')?.dispatchEvent(new dom.window.Event("click"));
    await flush();
    const call = take((m) => m.method === "tools/call");
    if (
      !call ||
      JSON.stringify(call.params.arguments.exact?.spatial) !== JSON.stringify(["Lomé", "Cotonou"]) ||
      call.params.arguments.country !== "Benin"
    )
      fail("co-occurrence did not intersect both exact values");
    if (call) await answer(call, BASE);
  }
  {
    await renderPayload({
      view: "lunar",
      subset: "images",
      filters: { country: "Togo" },
      total_matches: 6,
      distribution_by_group: { Togo: { "09": 4 }, Benin: { "09": 2 } },
      group_by: "country",
    });
    if (!rootEl.innerHTML.includes("6 placed") || rootEl.innerHTML.includes("No items"))
      fail("grouped lunar data disappeared");
    const call = await press("act-peak");
    if (
      call?.params.name !== "explore_corpus" ||
      call.params.arguments.subset !== "images" ||
      call.params.arguments.selection?.country !== "Togo"
    )
      fail("lunar peak lost subset or filters");
    if (call)
      await answer(call, {
        view: "records",
        mode: "items",
        subset: "images",
        filters: { country: "Togo" },
        total_matches: 1,
        rows: [{ id: "images:701", title: "Mosquée", url: "https://islam.zmo.de/s/afrique_ouest/item/701" }],
      });
    outbound.length = 0;
    rootEl.querySelector('[data-id="images:701"]')?.click();
    await flush();
    const read = take((m) => m.method === "tools/call");
    if (read?.params.name !== "fetch") fail("source list cannot open a reader");
    if (read)
      await answer(read, {
        id: "images:701",
        title: "Mosquée",
        text: "<script>not executable</script>",
        url: "https://islam.zmo.de/s/afrique_ouest/item/701",
        metadata: {},
      });
    if (!rootEl.querySelector(".source-text") || rootEl.querySelector("script"))
      fail("reader did not safely render source text");
  }
  {
    await renderPayload(BASE);
    const earlier = await press("act-gran"),
      later = await press("act-group");
    if (earlier && later) {
      await answer(later, { ...BASE, distribution: { 2004: 3 } });
      await answer(earlier, { ...BASE, distribution: { 1999: 9 } });
      if (!rootEl.innerHTML.includes("2004") || rootEl.innerHTML.includes("1999"))
        fail("stale response overwrote newer navigation");
    }
  }
  {
    await renderPayload({
      view: "coverage",
      subset: "articles",
      filters: { keyword: "islam" },
      source_field: "newspaper",
      total_matches: 3,
      rows: [{ source: "Le Pays", year: "2003", total: 3, fulltext: 2, embedded: 2, scored: 3 }],
    });
    const cell = rootEl.querySelector('[data-key="Le Pays"][data-key2="2003"]');
    outbound.length = 0;
    cell?.dispatchEvent(new dom.window.Event("click"));
    await flush();
    const call = take((m) => m.method === "tools/call");
    if (
      call?.params.arguments.selection?.exact?.newspaper?.[0] !== "Le Pays" ||
      call.params.arguments.selection.keyword !== "islam"
    )
      fail("coverage cell lost the selection");
    if (call) await answer(call, { error: "simulated unavailable source" }, true);
    if (!rootEl.querySelector("svg") || !rootEl.innerHTML.includes("simulated unavailable"))
      fail("failed source reading removed its chart");
  }

  {
    for (const [view, rowsKey, countKey, subset] of [["newspapers","newspapers","article_count","articles"],["periodicals","periodicals","issue_count","publications"]]) {
      await renderPayload({view,country_filter:"Benin",[rowsKey]:[{newspaper:"Same title",country:"Benin",[countKey]:3,earliest_year:2000,latest_year:2003}]});
      outbound.length=0; rootEl.querySelector(".hit[data-key]")?.dispatchEvent(new dom.window.Event("click")); await flush();
      const call=take(m=>m.method==="tools/call");
      if (call?.params.arguments.subset!==subset || call.params.arguments.country!=="Benin" || call.params.arguments.exact?.newspaper?.[0]!=="Same title") fail(`${view} lost exact outlet/country scope`);
      if (call) await answer(call,BASE);
    }
    await renderPayload({...BASE,filters:{exact:{spatial:["Cotonou","Lomé"]}}});
    if(rootEl.innerHTML.includes("[object Object]") || !rootEl.innerHTML.includes("Cotonou AND Lomé")) fail("exact filters are not readable in chips");
    const svg=await press("act-svg","ui/download-file");
    if(svg){const text=svg.params.contents[0].resource.text;if(!text.includes('xmlns="http://www.w3.org/2000/svg"') || !text.includes("<style>")) fail("SVG export is not standalone");deliver({jsonrpc:"2.0",id:svg.id,result:{}});await flush();}
  }

  // Pair matrices use their selected field and common pair base, and selectors
  // preserve the full research scope through the server's top-level filters.
  {
    const payload = {view:"sentiment", model:"all", models:["alpha","beta","gamma"], total_articles:5,
      filters:{country:"Benin",date_from:"2000",exact:{spatial:["Cotonou"]}},
      by_model:{alpha:{polarity_distribution:{Positif:3}},beta:{polarity_distribution:{Neutre:3}},gamma:{polarity_distribution:{Positif:2}}},
      agreement_matrix:{rows:"alpha",cols:"beta",field:"centrality",counts:{Central:{Marginal:2}},common_scored:2,excluded_articles:3,agreement_percent:0,kappa:0,weighted_n:2,notes:["Quadratic ordinal weights."]}};
    await renderPayload(payload);
    if(!rootEl.innerHTML.includes("2 articles have recognized centrality labels") || !rootEl.innerHTML.includes("Weighted κ: undefined"))
      fail("pair matrix omitted its population or undefined statistic");
    outbound.length=0;
    rootEl.querySelector('.pair-controls')?.dispatchEvent(new dom.window.Event("submit",{cancelable:true}));await flush();
    const pair = take((m)=>m.method==="tools/call");
    if(pair?.params.arguments.country!=="Benin" || pair.params.arguments.date_from!=="2000" ||
      pair.params.arguments.exact?.spatial?.[0]!=="Cotonou" || pair.params.arguments.selection ||
      pair.params.arguments.agreement_field!=="centrality" || pair.params.arguments.compare_models?.join(",")!=="alpha,beta")
      fail("pair selector changed the chosen pair, field or top-level scope");
    if(pair) await answer(pair,payload);
    outbound.length=0;
    rootEl.querySelector('[data-key="Central"][data-key2="Marginal"]')?.dispatchEvent(new dom.window.Event("click"));await flush();
    const drill = take((m)=>m.method==="tools/call");
    const exact = drill?.params.arguments.selection?.exact;
    if(exact?.["centrality:alpha"]?.[0]!=="Central" || exact?.["centrality:beta"]?.[0]!=="Marginal" || exact?.scored_by || exact?.spatial?.[0]!=="Cotonou")
      fail("pair cell used the wrong field, widened scope or required other models");
    if(drill) await answer(drill,BASE);
    await renderPayload({...payload,agreement_matrix:{...payload.agreement_matrix,common_scored:0,agreement_percent:undefined,kappa:undefined,counts:{}}});
    if(!rootEl.innerHTML.includes("Pair agreement: undefined (no shared labels)")) fail("no shared pair labels rendered as zero agreement");
  }

  {
    const markup = await renderPayload({view:"comparison",subset:"articles",filters:{},total_matches:3,overlap:0,rows:[],
      selections:[{label:"A",filters:{country:"Benin"},total:2},{label:"B",filters:{country:"Togo"},total:1}],
      temporal:{normalize_by:"corpus",omitted_years:0,note:"Corpus coverage is not historical prevalence.",rows:[
        {selection:"A",year:"2000",count:2,denominator:10,share:0.2},{selection:"B",year:"2000",count:1,denominator:10,share:0.1}]}});
    if(!markup.includes("Yearly counts and denominators") || !markup.includes("historical prevalence") || !rootEl.querySelector("svg"))
      fail("comparison timeline omitted denominators or interpretation note");
  }

  // Coverage drill-down must reproduce a whole pipe-joined country category.
  {
    await renderPayload({
      view: "coverage", subset: "references", filters: {}, source_field: "country",
      source_exact_field: "country_raw", total_matches: 1,
      rows: [{ source: "Niger|Nigeria", year: "2015", total: 1, fulltext: 1 }],
    });
    outbound.length = 0;
    rootEl.querySelector('[data-key="Niger|Nigeria"]')?.dispatchEvent(new dom.window.Event("click"));
    await flush();
    const call = take((m) => m.method === "tools/call");
    if (call?.params.arguments.selection?.exact?.country_raw?.[0] !== "Niger|Nigeria")
      fail("coverage drill-down did not preserve raw multi-country category");
    if (call) await answer(call, BASE);
    const pending = await press("act-gran");
    if (rootEl.getAttribute("aria-busy") !== "true") fail("pending navigation has no busy state");
    elements.get("act-back")?.click();
    await flush();
    if (rootEl.hasAttribute("aria-busy")) fail("Back retained stale busy state");
    if (pending) await answer(pending, BASE);
    if (!rootEl.innerHTML.includes("Source coverage over time")) fail("invalidated response overrode Back");
    if (rootEl.innerHTML.includes("Show embedded")) fail("unavailable coverage metric is still offered");
  }

  // An unsolicited new result also invalidates in-flight loading state.
  {
    await renderPayload(BASE);
    const pending = await press("act-gran");
    await renderPayload({ ...BASE, distribution: { 2020: 5 } });
    if (rootEl.hasAttribute("aria-busy")) fail("new host result retained stale busy state");
    if (pending) await answer(pending, { ...BASE, distribution: { 1990: 5 } });
    if (!rootEl.innerHTML.includes("2020") || rootEl.innerHTML.includes("1990")) fail("old request replaced host result");
  }

  {
    await renderPayload({view:"records", mode:"concordance", subset:"articles", filters:{keyword:"imam"}, total_matches:1,
      rows:[{id:"articles:1", title:"Source", excerpts:["An imam spoke."], matched_terms:["imam"], match_count:1,
        contexts:[{term:"imam",match:"imam",left:"An ",right:" spoke.",start:3,end:7,offset_unit:"utf16"}]}]});
    const csvCall = await press("act-csv", "ui/download-file");
    if (csvCall) {
      const csv = csvCall.params.contents[0]?.resource?.text ?? "";
      if (!csv.includes("excerpts,matched_terms,match_count,contexts") || !csv.includes("An imam spoke.") || !csv.includes("offset_unit"))
        fail("concordance CSV lost its contexts, terms or offsets");
      deliver({jsonrpc:"2.0",id:csvCall.id,result:{}}); await flush();
    }
    await renderPayload({view:"reader", id:"articles:1",title:"Source",text:"Text",url:"https://islam.zmo.de/source"});
    const open = await press("act-source", "ui/open-link");
    if(open){deliver({jsonrpc:"2.0",id:open.id,result:{}});await flush();}
    if(elements.get("act-source")?.disabled || elements.get("act-source")?.textContent !== "Open canonical source")
      fail("successful source opening left its button busy");
    if(rootEl.querySelector(".source-url")?.getAttribute("value") !== "https://islam.zmo.de/source")
      fail("reader lost selectable source URL fallback");
  }

  // Downloads preserve the provenance of the displayed page, and citation
  // formats keep the manifest containing canonical IDs and dataset identities.
  {
    await renderPayload(BASE, null, {snapshot_id:"test-snapshot"});
    const download = await press("act-csv", "ui/download-file");
    if(download){
      const files = download.params.contents;
      const sidecar = files.find((f)=>f.resource.uri.endsWith(".provenance.json"));
      const metadata = JSON.parse(sidecar?.resource.text ?? "{}");
      if(metadata.provenance?.snapshot_id!=="test-snapshot" || metadata.filters?.keyword!=="laïcité") fail("CSV lost provenance/selection sidecar");
      deliver({jsonrpc:"2.0",id:download.id,result:{}});await flush();
    }
    const manifest={records:[{id:"articles:1",url:"https://islam.zmo.de/item/1"}],provenance:{snapshot_id:"citation-snapshot"}};
    await renderPayload({view:"records",mode:"csl_json",subset:"articles",filters:{},rows:[],total_matches:0,
      export:{format:"csl_json",filename:"iwac-citations.json",mime_type:"application/vnd.citationstyles.csl+json",content:"[]",manifest}});
    const citation = await press("act-export", "ui/download-file");
    if(citation){
      const sidecar = citation.params.contents.find((f)=>f.resource.uri.endsWith(".manifest.json"));
      if(JSON.stringify(JSON.parse(sidecar?.resource.text ?? "{}"))!==JSON.stringify(manifest)) fail("citation download lost its selection manifest");
      deliver({jsonrpc:"2.0",id:citation.id,result:{}});await flush();
      if(elements.get("act-export")?.disabled) fail("citation export cannot be repeated");
    }
  }

  // SVG exports retain the visible legend, selected scope and methodological caveats.
  {
    await renderPayload({view:"temporal",subset:"articles",granularity:"year",group_by:"country",filters:{keyword:"scope-test"},
      total_matches:5,dated_count:4,undated_count:1,distribution_by_group:{Benin:{2000:3},Togo:{2000:1}}});
    const call = await press("act-svg", "ui/download-file");
    if(call){
      const svg = call.params.contents[0]?.resource?.text ?? "";
      if(!svg.includes("<style>") || !svg.includes(".tick")) fail("SVG export lost its real bundled stylesheet");
      if(!svg.includes("Selection: keyword: scope-test") || !svg.includes("carry no usable date")) fail("SVG export dropped scope/caveat");
      const parsed = parseHTML(svg).document;
      const visibleText = [...parsed.querySelectorAll("text")].map(x=>x.textContent);
      if(!visibleText.includes("Benin") || !visibleText.includes("Togo")) fail("SVG export has no visible series legend");
      deliver({jsonrpc:"2.0",id:call.id,result:{}});await flush();
      if(elements.get("act-svg")?.disabled) fail("SVG export action cannot be repeated");
    }
  }

  {
    await renderPayload({view:"places",subset:"articles",filters:{},total_matches:101,items_with_place:101,
      places:[{place:"Small",count:1,lat:6,lng:2},{place:"Large",count:100,lat:7,lng:3}]});
    const small = Number(rootEl.querySelector('[data-key="spatial:Small"]')?.getAttribute("r"));
    const large = Number(rootEl.querySelector('[data-key="spatial:Large"]')?.getAttribute("r"));
    if(Math.abs(small * small / (large * large) - 0.01) > 0.00001) fail("map bubble area is not proportional to counts");
  }

  {
    await renderPayload(BASE);
    const call = await press("act-gran");
    if(call){
      deliver({jsonrpc:"2.0",id:call.id,result:{isError:true,content:[{type:"text",text:"Permission unavailable"}]}});
      await flush();await flush();
      if(!rootEl.innerHTML.includes("Permission unavailable") || !rootEl.querySelector("svg")) fail("plain-text tool error lost its message or chart");
      if(rootEl.hasAttribute("aria-busy")) fail("failed tool left its busy state set");
    }
  }

  console.log(failures ? `\n${failures} APP CHECK(S) FAILED` : "\nALL APP CHECKS PASSED");
  process.exitCode = failures ? 1 : 0;
});
