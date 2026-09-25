import type { McpServer } from "@modelcontextprotocol/server";
import { registerArticleTools } from "./articles.js";
import { registerSentimentTools } from "./sentiment.js";
import { registerIndexTools } from "./indexTools.js";
import { registerStatsTools } from "./stats.js";
import { registerPublicationTools } from "./publications.js";
import { registerReferenceTools } from "./references.js";
import { registerDocumentTools } from "./documents.js";
import { registerAudiovisualTools } from "./audiovisual.js";
import { registerImageTools } from "./images.js";
import { registerAggregateTools } from "./aggregates.js";
import { registerSearchTools } from "./search.js";
import { registerAppResources } from "./appUi.js";
import { registerSkillResources } from "./skills.js";
import { registerPrompts } from "../prompts.js";
import type { Server } from "./_shared.js";

/** Register all IWAC tools, resources and prompts, grouped by domain. */
function registerAll(server: Server): void {
  // The one ui:// resource every chart renders from. Registered before the
  // tools so the resource exists by the time a tool advertises it in `_meta`.
  registerAppResources(server);
  // The `skill://` tree plus the SEP-2640 `skills/*` methods over the same
  // catalogue: the research workflow, served alongside the tools it documents
  // so remote-HTTP callers need no separate download.
  registerSkillResources(server);
  // Unified search/fetch first: they satisfy the OpenAI Deep Research contract and
  // are the entry point for skill-less clients (see INSTRUCTIONS in index.ts).
  registerSearchTools(server);
  registerArticleTools(server);
  registerSentimentTools(server);
  registerIndexTools(server);
  registerStatsTools(server);
  registerAggregateTools(server);
  registerPublicationTools(server);
  registerReferenceTools(server);
  registerDocumentTools(server);
  registerAudiovisualTools(server);
  registerImageTools(server);
  registerPrompts(server);
}

/** One recorded registration call, ready to apply to a fresh server. */
type Replay = (server: McpServer) => void;

type JsonSchemaConverter = (options?: unknown) => unknown;
const memoized = new WeakSet<object>();

/**
 * Cache a schema's Standard JSON Schema conversion (`~standard.jsonSchema`).
 *
 * The SDK converts a tool's schemas when it is registered and again on every
 * `tools/list`, with no cache of its own, so under the per-request factory
 * the same ~37 immutable schemas were converted twice per HTTP request. Once
 * the schema objects are shared (see recordRegistrations), a conversion
 * computed once is valid for the life of the process. Each call still gets
 * its own deep copy, so no caller can see another's mutations: the result is
 * indistinguishable from a fresh conversion, only cheaper.
 */
export function memoizeJsonSchema(schema: unknown): void {
  const converters = (schema as { "~standard"?: { jsonSchema?: Record<string, JsonSchemaConverter> } } | undefined)?.[
    "~standard"
  ]?.jsonSchema;
  if (!converters || memoized.has(converters)) return;
  memoized.add(converters);
  for (const io of ["input", "output"]) {
    const convert = converters[io];
    if (typeof convert !== "function") continue;
    const cache = new Map<string, unknown>();
    converters[io] = (options) => {
      const key = JSON.stringify(options ?? null);
      if (!cache.has(key)) cache.set(key, convert(options));
      return structuredClone(cache.get(key));
    };
  }
}

let replays: Replay[] | undefined;

/**
 * Run `registerAll` ONCE against a recorder, keeping each call's arguments.
 *
 * The HTTP entry builds a fresh McpServer per request (createMcpHandler's
 * factory model), and every build used to re-run all of registerAll: ~37 zod
 * schemas constructed from scratch and converted to JSON Schema, ~13 ms of CPU
 * before the request itself was looked at. None of it varies between builds.
 * The tool set depends only on process-level config, and no handler captures
 * its server or keeps per-server state: what they share (the DuckDB pool, the
 * embedding cache) already lives at module scope. So the arguments are built
 * once and replayed, handing every server the same schema and handler
 * objects. That is the SDK's own advice: keep the factory cheap and hold what
 * is shared at module scope.
 *
 * The recorder answers exactly the `Server` surface. That type is narrowed
 * to these four members for this reason, so a register function cannot reach
 * past the recorder unnoticed.
 */
function recordRegistrations(): Replay[] {
  const recorded: Replay[] = [];
  const recorder = {
    registerTool(...args: Parameters<McpServer["registerTool"]>) {
      memoizeJsonSchema(args[1].inputSchema);
      memoizeJsonSchema(args[1].outputSchema);
      recorded.push((s) => s.registerTool(...args));
    },
    registerResource(...args: Parameters<McpServer["registerResource"]>) {
      recorded.push((s) => s.registerResource(...args));
    },
    registerPrompt(...args: Parameters<McpServer["registerPrompt"]>) {
      memoizeJsonSchema(args[1].argsSchema);
      recorded.push((s) => s.registerPrompt(...args));
    },
    server: {
      setRequestHandler(...args: Parameters<McpServer["server"]["setRequestHandler"]>) {
        recorded.push((s) => s.server.setRequestHandler(...args));
      },
    },
  };
  // The one cast in this scheme: the recorder's methods return nothing where
  // McpServer's return the registered handle, which no caller here reads.
  registerAll(recorder as unknown as Server);
  return recorded;
}

/** Apply every IWAC tool, resource, prompt and method registration to
 * `server`, recording them on first use. */
export function registerServerFeatures(server: McpServer): void {
  replays ??= recordRegistrations();
  for (const replay of replays) replay(server);
}
