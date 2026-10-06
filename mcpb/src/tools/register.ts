import { requestProvenance, PROVENANCE_META_KEY } from "../provenance.js";
import { withRequest } from "../request.js";
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
import { registerDiscoveryResource } from "./discovery.js";
import { registerResearchTools } from "./research.js";
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
  registerDiscoveryResource(server);
  // Unified search/fetch first: they satisfy the OpenAI Deep Research contract and
  // are the entry point for skill-less clients (see INSTRUCTIONS in index.ts).
  registerSearchTools(server);
  registerResearchTools(server);
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
 * Drop the `minimum: -2^53+1` / `maximum: 2^53-1` that zod writes on every
 * `.int()`. They tell a model nothing (no id, limit or offset comes near them)
 * and cost ~20 tokens per integer field: ~1,200 of a 16,000-token always-on
 * budget across 64 fields. Validation is unchanged, because the SDK parses
 * arguments with the zod schema itself, which still enforces safe integers.
 * Real bounds (`.min(1)`, `.max(50)`) are kept.
 */
export function dropSafeIntegerBounds<T>(json: T): T {
  if (Array.isArray(json)) {
    for (const item of json) dropSafeIntegerBounds(item);
  } else if (json && typeof json === "object") {
    const node = json as Record<string, unknown>;
    if (node.minimum === Number.MIN_SAFE_INTEGER) delete node.minimum;
    if (node.maximum === Number.MAX_SAFE_INTEGER) delete node.maximum;
    for (const value of Object.values(node)) dropSafeIntegerBounds(value);
  }
  return json;
}

/**
 * Cache a schema's Standard JSON Schema conversion (`~standard.jsonSchema`),
 * minus the safe-integer bounds (see dropSafeIntegerBounds).
 *
 * The SDK converts a tool's schemas when it is registered and again on every
 * `tools/list`, with no cache of its own, so under the per-request factory
 * the same ~37 immutable schemas were converted twice per HTTP request. Once
 * the schema objects are shared (see recordRegistrations), a conversion
 * computed once is valid for the life of the process. Each call still gets
 * its own deep copy, so no caller can see another's mutations.
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
      if (!cache.has(key)) cache.set(key, dropSafeIntegerBounds(convert(options)));
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
      const [name, definition, callback] = args;
      recorded.push((s) =>
        s.registerTool(name, definition, (input, extra) =>
          withRequest(extra.mcpReq.signal, async () => {
            const result = await callback(input, extra);
            if (result.isError) return result;
            const provenance = requestProvenance(name, input);
            return {
              ...result,
              _meta: { ...result._meta, [PROVENANCE_META_KEY]: provenance },
              content: [
                ...(Array.isArray(result.content) ? result.content : []),
                { type: "text" as const, text: JSON.stringify({ provenance }) },
              ],
            };
          }),
        ),
      );
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
