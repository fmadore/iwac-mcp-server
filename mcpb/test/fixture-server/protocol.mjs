// Fixture-server checks for the protocol surface: the handshake (instructions,
// prompts, the ui:// resource, tool annotations, manifest parity), a degraded
// cache with one subset unloadable, and the 2026-07-28 era over stdio. Called
// in order by test/fixture-server.test.mjs, which owns the shared connection.
import { cpSync, readFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import { checkManifestParity, createHarness, expectedToolCount } from "../_harness.mjs";

/** Runs first, on the shared legacy-era client. Returns what the modern-era checks compare against. */
export async function handshakeChecks({ root, client, fail }) {
  // --- handshake ---------------------------------------------------------------
  const instructions = client.getInstructions?.() ?? "";
  if (!instructions) fail("no instructions in handshake");
  if (instructions.includes("semantic_search"))
    fail("instructions mention semantic_search_* although semantic search is disabled (conditional block regressed)");
  if (!instructions.includes("get_temporal_distribution"))
    fail("instructions do not mention get_temporal_distribution");
  if (!instructions.includes("The public dataset omits restricted OCR") || instructions.includes("{{"))
    fail("public-mode instructions lost their coverage sentence or left a placeholder unfilled");

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

  // The full-screen copy: same document, plus Claude's one-time display hint.
  // Over stdio there is no connector URL, so neither copy names a sandbox host.
  {
    const wide = await client.readResource({ uri: "ui://iwac/charts-wide.html" });
    const narrow = await client.readResource({ uri: "ui://iwac/charts.html" });
    if (wide.contents[0]?.text !== narrow.contents[0]?.text) fail("the full-screen chart resource must serve the same document");
    if (wide.contents[0]?._meta?.ui?.preferredDisplayMode !== "fullscreen")
      fail(`full-screen resource should prefer fullscreen, got ${JSON.stringify(wide.contents[0]?._meta)}`);
    if (narrow.contents[0]?._meta?.ui?.preferredDisplayMode !== undefined)
      fail("the shared chart resource must not ask for fullscreen: every small chart would open in the side panel");
    for (const read of [wide, narrow])
      if (read.contents[0]?._meta?.ui?.domain !== undefined) fail("stdio must not declare a sandbox domain (it has no connector URL)");
  }

  // Claude's sidebar entry point needs a raster data: URI icon under 10 KB.
  {
    const icon = client.getServerVersion()?.icons?.[0];
    if (!/^data:image\/(png|jpeg);base64,/.test(icon?.src ?? "")) fail(`serverInfo icon must be an inline PNG/JPEG data: URI, got ${icon?.src?.slice(0, 40)}`);
    else if (Buffer.from(icon.src.split(",")[1], "base64").length > 10_000) fail("serverInfo icon must stay under 10 KB");
  }

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  // Exactly one tool opens IWAC without a prompt, and it must meet Claude's
  // entry-point conditions: a UI, model-visible, no required input, a safe name.
  {
    const entries = tools.tools.filter((t) => t._meta?.["openai/ui"]?.entrypoints?.some((e) => e.type === "global"));
    if (entries.map((t) => t.name).join() !== "get_collection_stats")
      fail(`get_collection_stats should be the one global entry point, got ${entries.map((t) => t.name).join(", ") || "none"}`);
    for (const t of entries) {
      if ((t.inputSchema?.required ?? []).length) fail(`entry point ${t.name} must have no required input`);
      if (/__|\.\.|\._|_\./.test(t.name)) fail(`entry point name ${t.name} breaks Claude's naming rule`);
      if ((t.title ?? "").length > 60) fail(`entry point ${t.name} title exceeds 60 characters`);
      if (t._meta?.ui?.visibility && !t._meta.ui.visibility.includes("model")) fail(`entry point ${t.name} must stay model-visible`);
    }
  }
  if (tools.tools.find((x) => x.name === "get_semantic_map")?._meta?.ui?.resourceUri !== "ui://iwac/charts-wide.html")
    fail("get_semantic_map should open the full-screen chart resource");
  // Every other chart-bearing tool points at the SAME resource — that is what
  // keeps the suite to one copy of the SDK (docs/mcp-apps-roadmap.md §2.2).
  for (const n of [
    "get_temporal_distribution",
    "get_topic_distribution",
    "get_field_distribution",
    "get_cooccurrence",
    "get_lexical_metrics",
    "get_place_distribution",
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
  const toolCount = expectedToolCount();
  if (tools.tools.length !== toolCount) {
    fail(`expected ${toolCount} tools with semantic off, got ${tools.tools.length}: ${names.join(", ")}`);
  }
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

  return { instructions, promptNames, names };
}

/** Runs after the shared client is closed, on its own copy of the fixtures. */
export async function degradedCacheChecks({ root, fixtures, reporter }) {
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

    const { client: degradedClient, close: closeDegraded } = await fixtures.connect({
      name: "degraded-test", cacheDir: degradedDir, stderr: "ignore",
    });
    const { call: degradedCall } = createHarness(degradedClient, { timeoutMs: 60_000, reporter });

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

    await closeDegraded();
    rmSync(degradedDir, { recursive: true, force: true });
  }
}

/** Runs last. `legacy` is what handshakeChecks returned. */
export async function modernEraChecks({ fixtures, reporter }, { instructions, promptNames, names }) {
  // --- the 2026-07-28 era over stdio -------------------------------------------
  // Everything above ran on the default `versionNegotiation` — the 2025
  // `initialize` handshake — so it proves only the legacy leg. `serveStdio` is
  // supposed to serve both eras from one factory; pin the modern revision so
  // there is no fallback to mask a regression.
  {
    const { client: modern, close: closeModern } = await fixtures.connect({
      name: "fixture-test-modern",
      clientOptions: { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    });
    const { call: modernCall, fail: modernFail } = createHarness(modern, { timeoutMs: 60_000, reporter });

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

    await closeModern();
  }
}
