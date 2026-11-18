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
//
// The render cases and the interaction checks live in test/app/, one module
// per domain. They share this file's single app instance and run in its order:
// each check reads the state the previous one left on screen.
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps";
import { createReporter } from "./_harness.mjs";
import * as vm from "node:vm";
import { gunzipSync } from "node:zlib";
import { parseHTML } from "linkedom";
import { withFixtureScope } from "./_fixture-client.mjs";
import { addOverviewCases } from "./app/cases-overview.mjs";
import { addAggregateCases } from "./app/cases-aggregates.mjs";
import { addMapCases } from "./app/cases-maps.mjs";
import { viewSplitChecks } from "./app/view-split.mjs";
import { interactionChecks } from "./app/interactions.mjs";
import { selectionExportHostChecks } from "./app/selection-export-host.mjs";

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

  const reporter = createReporter();
  const { fail } = reporter;

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
        hostContext: {
          theme: "dark",
          toolInfo: { tool: { name: "get_temporal_distribution", inputSchema: { type: "object" } } },
        },
      },
    });
    await flush();
    if (documentElement.getAttribute("data-theme") !== "dark")
      fail(`app ignored the host theme (data-theme=${documentElement.getAttribute("data-theme")})`);
    // Declared so the host can offer its own expand control; pip is not.
    const modes = init.params.appCapabilities?.availableDisplayModes;
    if (JSON.stringify(modes) !== JSON.stringify(["inline", "fullscreen"]))
      fail(`app declared display modes ${JSON.stringify(modes)}, expected inline + fullscreen`);
  }

  // --- in-flight state -----------------------------------------------------------

  // Between the model's call and its result the frame names what is computed,
  // with the selection as chips, and stays out of model context.
  {
    outbound.length = 0;
    deliver({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input",
      params: { arguments: { subset: "articles", selection: { country: "Togo", keyword: "<b>imam</b>" } } },
    });
    await flush();
    const status = rootEl.querySelector(".pending[role=status]");
    if (!status) fail("tool input did not show a pending state");
    else {
      if (!status.textContent.includes("Computing temporal distribution"))
        fail(`pending state did not name the tool: ${status.textContent}`);
      if (!status.innerHTML.includes("country: Togo")) fail("pending state did not lift the selection into chips");
      if (status.innerHTML.includes("<b>")) fail("pending state rendered tool arguments unescaped");
    }
    if (rootEl.getAttribute("aria-busy") !== "true") fail("pending state is not marked aria-busy");
    if (take((m) => m.method === "ui/update-model-context")) fail("tool input pushed model context");
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

  addOverviewCases(CASES);
  addAggregateCases(CASES);
  addMapCases(CASES);

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

  await viewSplitChecks({ fail, renderPayload, checkMarkup });

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

  const ui = { fail, dom, rootEl, elements, outbound, documentElement, deliver, take, flush, renderPayload, BASE, press, answer };
  await interactionChecks(ui);
  await selectionExportHostChecks(ui);

  console.log(reporter.failures() ? `\n${reporter.failures()} APP CHECK(S) FAILED` : "\nALL APP CHECKS PASSED");
  process.exitCode = reporter.failures() ? 1 : 0;
});
