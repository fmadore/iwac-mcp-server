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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as vm from "node:vm";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Hard ceiling on the shipped UI resource. It is inlined into server/index.js,
 * so it rides in every .mcpb and every Docker image, and the whole point of
 * one shared resource (docs/mcp-apps-roadmap.md §2.2) is that adding the Nth
 * chart costs kilobytes rather than another copy of the SDK. If this trips,
 * check WHY it grew before raising it: +4 kb for a new chart is the deal,
 * +190 kb means something pulled in a second SDK copy or the locale stubbing
 * regressed.
 */
const UI_BUDGET_KB = 230;

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error(`  FAIL: ${msg}`);
};

// --- fetch the resource the way a host does ----------------------------------

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
const client = new Client({ name: "app-test", version: "0.0.0" });
await client.connect(transport);

const listed = await client.listResources();
const entry = listed.resources.find((r) => r.uri === "ui://iwac/charts.html");
if (!entry) fail(`ui://iwac/charts.html not registered (got ${listed.resources.map((r) => r.uri).join(", ") || "none"})`);

const read = await client.readResource({ uri: "ui://iwac/charts.html" });
const html = read.contents[0]?.text ?? "";
const mimeType = read.contents[0]?.mimeType;

// The MIME type is duplicated in src/tools/appUi.ts rather than imported (the
// server must not depend on ext-apps at runtime). Pin the copy to the real
// constant so the two cannot drift.
if (mimeType !== RESOURCE_MIME_TYPE) fail(`resource mimeType ${mimeType}, expected ${RESOURCE_MIME_TYPE}`);
if (!html.includes("<!DOCTYPE html>")) fail("UI resource is not an HTML document");
if (html.includes("run `npm run build`")) fail("UI fell back to the dev placeholder — rebuild before testing");

const sizeKb = Buffer.byteLength(html) / 1024;
if (sizeKb > UI_BUDGET_KB) fail(`UI resource is ${sizeKb.toFixed(1)}kb, over the ${UI_BUDGET_KB}kb budget`);
else console.log(`  ui resource ${sizeKb.toFixed(1)}kb / ${UI_BUDGET_KB}kb budget`);

await client.close();

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

/** Elements the app looks up by id after writing innerHTML. */
function scanIds(markup, registry) {
  registry.clear();
  for (const m of markup.matchAll(/id="([^"]+)"/g)) {
    const id = m[1];
    const label = markup.slice(m.index).match(/>([^<]*)</);
    registry.set(id, {
      id,
      disabled: false,
      textContent: label ? label[1] : "",
      listeners: {},
      addEventListener(type, fn) {
        this.listeners[type] ??= [];
        this.listeners[type].push(fn);
      },
      // Deliberately NOT awaited: the app's click handler awaits a tools/call
      // that only settles once this harness answers it, so awaiting here would
      // deadlock. Callers flush, inspect the outbound request, then answer.
      click() {
        for (const fn of this.listeners.click ?? []) fn();
      },
    });
  }
}

const elements = new Map();
const rootEl = {
  _html: "",
  get innerHTML() {
    return this._html;
  },
  set innerHTML(v) {
    this._html = v;
    scanIds(v, elements);
  },
  querySelectorAll: () => [],
  addEventListener() {},
};

const outbound = [];
let messageListener = null;

const documentElement = {
  _attrs: {},
  style: {},
  classList: { contains: () => false },
  setAttribute(k, v) {
    this._attrs[k] = v;
  },
  getAttribute(k) {
    return this._attrs[k] ?? null;
  },
  // The SDK's auto-resize measures the document on every frame.
  getBoundingClientRect: () => ({ height: 400, width: 900 }),
};

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
  document: {
    documentElement,
    body: { style: {}, getBoundingClientRect: () => ({ height: 400 }) },
    head: { appendChild() {} },
    createElement: () => ({ style: {}, setAttribute() {} }),
    getElementById: (id) => (id === "root" ? rootEl : (elements.get(id) ?? null)),
  },
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

const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
if (!script.trim()) fail("no inline script found in the UI resource");

// This is the zod-locale-stub smoke check: the IIFE runs zod's module
// initialisation, the App constructor and z.config() as it evaluates.
try {
  vm.runInNewContext(script, sandbox, { filename: "charts.js" });
} catch (err) {
  fail(`the app bundle threw while booting: ${err.stack}`);
  process.exit(1);
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

/** Push a tool result at the app the way a host does, and return the markup. */
async function renderPayload(payload) {
  outbound.length = 0;
  deliver({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload },
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
  if (call && call.params.arguments.group_by !== "country") fail("group_by toggle did not request a country grouping");
  // A rejected re-call must keep the chart on screen rather than blanking it:
  // a group_by the subset cannot serve should not cost the user their place.
  if (call) {
    await answer(call, { error: "group_by 'country' is not available for subset 'documents'" }, true);
    const markup = rootEl.innerHTML;
    if (!markup.includes("not available")) fail("a rejected re-call did not surface its error");
    if (!markup.includes("<svg")) fail("a rejected re-call blanked the chart instead of keeping it");
  }
}

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
  }
}

console.log(failures ? `\n${failures} APP CHECK(S) FAILED` : "\nALL APP CHECKS PASSED");
process.exit(failures ? 1 : 0);
