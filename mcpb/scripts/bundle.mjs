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

// --- MCP App UI ------------------------------------------------------------
// The coverage chart is bundled to a single IIFE and inlined into ONE
// self-contained HTML string, then injected into the server bundle as a define.
// Two constraints force this shape: MCP App resources render under a
// deny-by-default CSP (no external script, stylesheet or font may load), and the
// .mcpb package expects a single-file server, so the HTML cannot be a sibling
// asset read from disk at runtime.
const ui = await esbuild.build({
  absWorkingDir: rootDir,
  entryPoints: [join(rootDir, "src", "app", "coverage.ts")],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2020",
  minify: true,
  legalComments: "none",
  write: false,
});
const uiScript = ui.outputFiles[0].text;
const uiHtml = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>IWAC coverage over time</title>
<style>
/* Colours mirror the IwacVisualizations Omeka module's resolved theme tokens
   (asset/js/iwac-theme.js FALLBACK_LIGHT / FALLBACK_DARK) so a chart rendered
   in Claude reads like the same chart on islam.zmo.de. The site's Public Sans
   cannot be fetched under the app CSP, so the stack degrades to system-ui —
   the module's own fallback chain, kept verbatim. */
:root{color-scheme:light dark;--fg:#13161c;--muted:#66696e;--line:#ced1d6;--chip:#f7f5f3;--btn:#faf8f6}
@media (prefers-color-scheme:dark){:root{--fg:#e7e4df;--muted:#8a8580;--line:#352f28;--chip:#1a1510;--btn:#1a1510}}
*{box-sizing:border-box}
body{margin:0;padding:14px;font:14px/1.45 "Public Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg);background:transparent}
h1{margin:0 0 2px;font-size:15px;font-weight:600;text-transform:capitalize}
.totals{margin:0 0 8px;color:var(--muted);font-size:13px}
.chips{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px}
.chip{background:var(--chip);border-radius:10px;padding:2px 8px;font-size:12px}
.chip.muted{color:var(--muted)}
.chart{overflow-x:auto}
svg{display:block;width:100%;min-width:520px;height:auto}
.grid{stroke:var(--line);stroke-width:1}
.tick{fill:var(--muted);font-size:11px}
.legend{list-style:none;display:flex;flex-wrap:wrap;gap:10px;margin:8px 0 0;padding:0;font-size:12px}
.legend li{display:flex;align-items:center;gap:5px}
.swatch{width:10px;height:10px;border-radius:2px;display:inline-block}
.foot{margin:8px 0 0;color:var(--muted);font-size:12px}
.empty{color:var(--muted);padding:24px 0;text-align:center}
.actions{margin-top:12px}
button{font:inherit;font-size:13px;padding:5px 11px;border:1px solid var(--line);border-radius:6px;background:var(--btn);color:var(--fg);cursor:pointer}
button:disabled{opacity:.6;cursor:default}
</style></head>
<body><div id="root"></div><script>${uiScript}</script></body></html>`;

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
  define: {
    __IWAC_VERSION__: JSON.stringify(pkg.version),
    __IWAC_UI_COVERAGE__: JSON.stringify(uiHtml),
  },
  logLevel: "info",
});
