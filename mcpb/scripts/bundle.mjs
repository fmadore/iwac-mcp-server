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

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

await esbuild.build({
  entryPoints: ["src/index.ts"],
  outfile: "server/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  // No banner shebang: src/index.ts already starts with `#!/usr/bin/env node`,
  // and esbuild hoists the entry point's shebang to line 1 of the bundle.
  legalComments: "none",
  external: ["@duckdb/*", "@google/genai"],
  define: { __IWAC_VERSION__: JSON.stringify(pkg.version) },
  logLevel: "info",
});
