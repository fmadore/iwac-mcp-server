#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { registeredToolNames, registerServerFeatures } from "./tools/register.js";
import { attachSkills } from "./tools/skills.js";
import { startHttpServer } from "./http.js";
import { stopSharedWork } from "./request.js";
import { config } from "./config.js";
import { FULLTEXT_INSTRUCTIONS } from "./coverage.js";
import { buildInstructions } from "./instructions.js";

// Injected by esbuild (scripts/bundle.mjs) from package.json — single source of
// truth for the version reported in the MCP handshake.
declare const __IWAC_VERSION__: string;
const VERSION = typeof __IWAC_VERSION__ === "string" ? __IWAC_VERSION__ : "0.0.0-dev";

/** The handshake instructions (src/instructions.ts), resolved against the
 * dataset mirror and the actual tool registration: they must not advertise
 * tools that IWAC_TOOL_PROFILE or IWAC_SEMANTIC_SEARCH_ENABLED dropped. Config
 * is fixed for the process, so this runs once, not once per server. */
const RESOLVED_INSTRUCTIONS = buildInstructions({
  fulltext: FULLTEXT_INSTRUCTIONS,
  tools: registeredToolNames(),
  externalEncoder: config.embeddingProvider === "local",
});

/**
 * How long a client may cache this server's list results (2026-07-28
 * `CacheableResult`; ignored on 2025-era connections). Every list here is fixed
 * at BUILD time — the tool, prompt and resource sets are literal registrations,
 * and static UI/skill resources are baked into the bundle — so they
 * cannot change without a redeploy, which reconnects stdio hosts anyway. An
 * hour is the spec's own worked example, and caching the tool list is what
 * keeps a host's prompt cache warm across calls. `public` because nothing in
 * the lists varies per caller: the factory reads no `authInfo`, and the only
 * thing that changes the tool set (semantic search) is a process-level env var.
 */
// Live dataset resources override the read default with a zero-TTL cache hint.
const CACHE_HINTS = {
  "tools/list": { ttlMs: 3_600_000, cacheScope: "public" },
  "prompts/list": { ttlMs: 3_600_000, cacheScope: "public" },
  "resources/list": { ttlMs: 3_600_000, cacheScope: "public" },
  "resources/read": { ttlMs: 3_600_000, cacheScope: "public" },
  "server/discover": { ttlMs: 3_600_000, cacheScope: "public" },
} as const;

/**
 * Cap on array elements plus object members in one `tools/call` arguments
 * payload, checked by the SDK before schema validation. The largest legitimate
 * call is explore_corpus with two full selections: a dozen fields each, 12
 * keyword aliases and an `exact` map of some 14 fields × 20 values, so ~650.
 * The cap sits above that and far below what the 4 MB body limit admits.
 */
const MAX_TOOL_INPUT_ELEMENTS = 1_000;

/**
 * Build a fully-configured MCP server. This is the SDK's server *factory*:
 * `serveStdio` calls it once per stdio connection, `createMcpHandler` once per
 * HTTP request. The same factory serves both protocol eras — the entry point
 * decides which era a given connection speaks, not this function.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: "iwac-mcp-server", version: VERSION },
    {
      instructions: RESOLVED_INSTRUCTIONS,
      cacheHints: CACHE_HINTS,
      maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
      capabilities: {
        // McpServer defaults every list to `listChanged: true`, but these lists
        // are fixed at build time (see CACHE_HINTS) and never change on a live
        // connection. A 2026-07-28 client reads these bits to choose what to
        // request on a `subscriptions/listen` stream, so advertising `true`
        // invited it to hold a stream open, through the proxy, for
        // notifications this server can never send.
        tools: { listChanged: false },
        resources: { listChanged: false },
        prompts: { listChanged: false },
      },
    },
  );
  registerServerFeatures(server);
  // The SEP-2640 Skills extension declares its own capability on attach, and
  // only when this build carries a skill: a host never negotiates the
  // extension against an empty catalogue.
  attachSkills(server);
  return server;
}

function runStdio(): void {
  // `serveStdio` owns the transport AND the era decision: the opening exchange
  // decides whether the connection speaks 2026-07-28 (`server/discover`, no
  // handshake) or a 2025-era `initialize`, then pins one instance from the
  // factory for the connection's lifetime. Its default `legacy: "serve"` is
  // what keeps existing hosts working — hand-wiring StdioServerTransport, as
  // this did under SDK v1, would serve the legacy era only.
  const handle = serveStdio(createServer, {
    onerror: (err) => console.error("[iwac] stdio error:", err),
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void Promise.allSettled([stopSharedWork(), handle.close()]).finally(() => process.exit(0));
    });
  }
  console.error(
    `[iwac] IWAC MCP server running on stdio ` +
      `(dataset: ${config.datasetRepo}, cache: ${config.cacheDir}, semantic: ${config.semanticSearchEnabled})`,
  );
}

function main(): void {
  if (process.argv.includes("--http")) {
    startHttpServer(createServer);
  } else {
    runStdio();
  }
}

try {
  main();
} catch (err) {
  console.error("[iwac] fatal:", err);
  process.exit(1);
}
