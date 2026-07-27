// Bundle the TypeScript server into a single ESM file at server/index.js.
//
// The server's own modules plus the MCP SDK and zod are inlined, so the packaged
// bundle no longer relies on node_modules resolution for the core server. Two
// dependency trees are kept EXTERNAL and must remain in node_modules at runtime:
//
//   @duckdb/*      — native bindings (.node/.dll/.so/.dylib) are loaded through a
//                    process.platform-based require and cannot be inlined.
//   @google/genai  — only used by the optional semantic-search tools; it pulls in
//                    google-auth-library + protobufjs, which rely on dynamic
//                    requires and runtime reflection that bundle poorly. Keeping it
//                    external preserves its exact current runtime behaviour.
import * as esbuild from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));

// --- zod locale stubbing ----------------------------------------------------
// zod's `v4/locales/index.js` re-exports 50+ error-message catalogues (Arabic,
// Hebrew, Japanese, …) and `v4/classic/external.js` re-exports that index as
// `z.locales`, so every catalogue lands in every bundle that touches zod. In
// the app bundle that was 195.0 kb of 387.6 kb — half the payload, for strings
// that can never fire. Only `en.js` is live: `classic/external.js` imports it
// directly to seed the default error map, and nothing in this project ever
// calls `z.config(z.locales.<x>())`.
//
// Two details are load-bearing, both learned by getting them wrong first:
//
//   * The filter has to be broad and match the RESOLVED path. esbuild runs
//     `onLoad` filters against absolute paths, so a specifier-shaped filter
//     (`/^zod\/v4\/locales\//`) silently matches nothing and the plugin looks
//     like it worked while saving zero bytes.
//   * `index.js` must NOT be stubbed. It is the re-export barrel; stubbing it
//     removes the `z.locales` namespace itself rather than its contents.
//
// The stub throws instead of exporting `undefined`, so if a future app really
// does want a non-English catalogue it fails with a message naming this plugin
// rather than "undefined is not a function" from deep inside zod. All 50 stubs
// re-export ONE shared virtual module, so that diagnostic costs ~200 bytes
// total instead of ~110 bytes each.
const STUB_MODULE = "iwac-virtual:zod-locale-stub";

const stubZodLocales = {
  name: "stub-zod-locales",
  setup(build) {
    build.onResolve({ filter: /^iwac-virtual:zod-locale-stub$/ }, (args) => ({
      path: args.path,
      namespace: "iwac-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "iwac-stub" }, () => ({
      contents:
        "export default function stubbedZodLocale(){throw new Error(" +
        '"This bundle ships only zod\'s English locale; the others are stubbed out by ' +
        'scripts/bundle.mjs. Drop the stub-zod-locales plugin to use z.locales.<lang>().")}',
      loader: "js",
    }));
    build.onLoad({ filter: /locales/ }, (args) => {
      const path = args.path.replaceAll("\\", "/");
      if (!path.includes("/zod/") || !path.includes("/locales/")) return null;
      if (/\/(?:en|index)\.js$/.test(path)) return null;
      return { contents: `export { default } from ${JSON.stringify(STUB_MODULE)};`, loader: "js" };
    });
  },
};

// --- MCP App UI ------------------------------------------------------------
// The whole chart suite is bundled to a single IIFE and inlined into ONE
// self-contained HTML string, then injected into the server bundle as a define.
// Two constraints force this shape: MCP App resources render under a
// deny-by-default CSP (no external script, stylesheet or font may load), and the
// .mcpb package expects a single-file server, so the HTML cannot be a sibling
// asset read from disk at runtime.
//
// One entry point, not one per chart: see src/tools/appUi.ts for why every
// UI-bearing tool points at the same `ui://` resource.
const ui = await esbuild.build({
  absWorkingDir: rootDir,
  entryPoints: [join(rootDir, "src", "app", "charts.ts")],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2020",
  minify: true,
  legalComments: "none",
  plugins: [stubZodLocales],
  write: false,
});
const uiScript = ui.outputFiles[0].text;
const uiHtml = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>IWAC charts</title>
<style>
/* Colours mirror the IwacVisualizations Omeka module's resolved theme tokens
   (asset/js/iwac-theme.js FALLBACK_LIGHT / FALLBACK_DARK) so a chart rendered
   in Claude reads like the same chart on islam.zmo.de. The site's Public Sans
   cannot be fetched under the app CSP, so the stack degrades to system-ui —
   the module's own fallback chain, kept verbatim.

   Theming keys off [data-theme], which src/app/theme.ts stamps on <html> from
   the host's declared theme; the prefers-color-scheme block is only the
   fallback for a host that sends none. */
:root{color-scheme:light dark;--fg:#13161c;--muted:#66696e;--line:#ced1d6;--chip:#f7f5f3;--btn:#faf8f6;--track:#e8e4e0;--warn:#a33b12;--land:#e3ded8;--bubble:#ce4115}
@media (prefers-color-scheme:dark){:root{--fg:#e7e4df;--muted:#8a8580;--line:#352f28;--chip:#1a1510;--btn:#1a1510;--track:#2a231c;--warn:#ec8b6a;--land:#2b241d;--bubble:#ec653f}}
:root[data-theme=light]{color-scheme:light;--fg:#13161c;--muted:#66696e;--line:#ced1d6;--chip:#f7f5f3;--btn:#faf8f6;--track:#e8e4e0;--warn:#a33b12;--land:#e3ded8;--bubble:#ce4115}
:root[data-theme=dark]{color-scheme:dark;--fg:#e7e4df;--muted:#8a8580;--line:#352f28;--chip:#1a1510;--btn:#1a1510;--track:#2a231c;--warn:#ec8b6a;--land:#2b241d;--bubble:#ec653f}
*{box-sizing:border-box}
body{margin:0;padding:14px;font:14px/1.45 "Public Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg);background:transparent}
h1{margin:0 0 2px;font-size:15px;font-weight:600;text-transform:capitalize}
.totals{margin:0 0 8px;color:var(--muted);font-size:13px}
.chips{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px}
.chip{background:var(--chip);border-radius:10px;padding:2px 8px;font-size:12px}
.chip.muted{color:var(--muted)}
.chart{overflow-x:auto}
.panels{display:flex;flex-wrap:wrap;gap:18px;align-items:flex-start}
.panel{flex:0 0 auto;text-align:center}
.panel h2{margin:0 0 2px;font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
svg{display:block;width:100%;height:auto}
.panel svg{width:auto;max-width:100%}
.grid{stroke:var(--line);stroke-width:1}
.tick{fill:var(--muted);font-size:11px}
.lbl{fill:var(--fg)}
.big{fill:var(--fg);font-size:19px;font-weight:600}
.cell{fill:#fff;font-size:12px;font-weight:600;paint-order:stroke;stroke:rgba(0,0,0,.28);stroke-width:2.5px}
.cell.dim{font-weight:400;opacity:.85}
.track{fill:var(--track)}
.land{stroke:var(--line);stroke-width:.6}
.neighbour{stroke:var(--line);stroke-width:.6;opacity:.5}
.bubble{fill:var(--bubble);fill-opacity:.55;stroke:var(--bubble);stroke-width:.8;cursor:pointer}
.bubble:hover{fill-opacity:.85}
.hit{cursor:pointer}
.hit:hover{opacity:.78}
.legend{list-style:none;display:flex;flex-wrap:wrap;gap:10px;margin:8px 0 0;padding:0;font-size:12px}
.legend li{display:flex;align-items:center;gap:5px}
.swatch{width:10px;height:10px;border-radius:2px;display:inline-block}
.foot{margin:8px 0 0;color:var(--muted);font-size:12px}
.warn{margin:0 0 8px;color:var(--warn);font-size:12px}
.empty{color:var(--muted);padding:24px 0;text-align:center}
.actions{margin-top:12px;display:flex;flex-wrap:wrap;gap:6px}
button{font:inherit;font-size:13px;padding:5px 11px;border:1px solid var(--line);border-radius:6px;background:var(--btn);color:var(--fg);cursor:pointer}
button:disabled{opacity:.6;cursor:default}
</style></head>
<body><div id="root"></div><script>${uiScript}</script></body></html>`;

// Report it: the UI is inlined into the server bundle as a string constant, so
// esbuild's own output summary hides it, and it is the one artifact whose size
// a new chart can quietly double. test/fixture-server.test.mjs enforces a hard
// budget; this line is so the number is visible while iterating.
console.log(`  ui resource   ${(Buffer.byteLength(uiHtml) / 1024).toFixed(1)}kb`);

await esbuild.build({
  absWorkingDir: rootDir,
  entryPoints: [join(rootDir, "src", "index.ts")],
  outfile: join(rootDir, "server", "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  // Deliberately BELOW the build baseline (Node 24 in CI, Docker and
  // package.json `engines`). Claude Desktop runs the extension on its own
  // bundled Node, whose version this project does not control, so the emitted
  // bundle stays parseable well below that. Raise this only together with
  // `compatibility.runtimes.node` in manifest.json, and only once Desktop's
  // bundled runtime is known to clear the new floor.
  target: "node18",
  // No banner shebang: src/index.ts already starts with `#!/usr/bin/env node`,
  // and esbuild hoists the entry point's shebang to line 1 of the bundle.
  legalComments: "none",
  external: ["@duckdb/*", "@google/genai"],
  // Same dead weight as in the UI build above, and the server bundle ships in
  // every .mcpb and every Docker image. The server declares its input schemas
  // with zod but never re-configures the locale, so the catalogues are as dead
  // here as they are in an iframe.
  plugins: [stubZodLocales],
  define: {
    __IWAC_VERSION__: JSON.stringify(pkg.version),
    __IWAC_UI_CHARTS__: JSON.stringify(uiHtml),
  },
  logLevel: "info",
});
