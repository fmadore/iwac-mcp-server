// MCP Apps: the one `ui://` resource behind every IWAC chart.
//
// MCP Apps (extension spec 2026-01-26, supported by Claude and Claude Desktop)
// let a tool declare an interactive HTML view that the host renders in a
// sandboxed iframe and feeds the tool result to. A tool opts in with
// `_meta.ui.resourceUri`; the host then fetches that resource and posts the
// result into the frame, and the frame can call tools back through the host.
// `_meta.ui.resourceUri` is the current key; the flat `ui/resourceUri` key that
// ext-apps still exports as RESOURCE_URI_META_KEY is deprecated, so it is not
// emitted. ext-apps 2.1 changed nothing here: its draft spec only stops
// requiring the host's double sandboxed iframe (a host may now serve the view
// as the document of a single sandboxed frame, CSP still set by the host),
// which leaves the view's postMessage channel to `window.parent`, its inline
// bootstrap and the CSP it runs under unchanged (see scripts/bundle.mjs).
//
// ONE resource serves all the charts. Each `ui://` resource is a standalone
// document that shares nothing with its siblings, so a resource per chart
// would mean a fresh copy of the MCP SDK and zod — ~190 kb — for every ~4 kb
// chart. Tools may all point at the same URI, so the whole suite costs one
// copy. See docs/mcp-apps-roadmap.md §2.2.
//
// The declaration is inert on hosts without MCP Apps support: `_meta` is ignored
// and the tools return exactly the same content and structuredContent as before.
// That is why this needs no capability negotiation and no second tool.
import type { Server } from "./_shared.js";
import { currentUiDomain } from "../uiDomain.js";

/** Injected by esbuild (scripts/bundle.mjs): the whole chart UI as one
 * self-contained HTML document, inline CSS and JS included, because MCP App
 * resources render under a deny-by-default CSP. */
declare const __IWAC_UI_CHARTS__: string;

/**
 * MIME type the MCP Apps extension defines for a UI resource, mirroring
 * `RESOURCE_MIME_TYPE` in `@modelcontextprotocol/ext-apps` — hosts advertise
 * support by listing exactly this string. It is duplicated rather than imported
 * because ext-apps is a devDependency (the browser half of the build) and the
 * server must not gain a runtime dependency on it; the fixture test imports the
 * real constant and asserts the two agree, so the copy cannot drift.
 */
export const UI_MIME_TYPE = "text/html;profile=mcp-app";

export const CHARTS_UI_URI = "ui://iwac/charts.html";

/**
 * The same document under a second URI, for views that need the whole screen
 * (the semantic map). Claude reads `preferredDisplayMode` from the resource,
 * not the tool, so a hint on the shared resource would push every small
 * timeline into the side panel. The HTML string is shared in memory; a host
 * fetches and caches each URI separately, which costs one extra download for
 * hosts that render both.
 */
export const WIDE_UI_URI = "ui://iwac/charts-wide.html";

/** `_meta` block a tool spreads in to declare its UI. */
export const CHARTS_UI_META = { ui: { resourceUri: CHARTS_UI_URI } };
export const WIDE_UI_META = { ui: { resourceUri: WIDE_UI_URI } };

/**
 * `_meta` for the one tool that opens IWAC without a prompt. Claude lists a
 * tool marked this way on its Artifacts page, where people can pin it to the
 * sidebar; opening it starts a conversation with the view already running.
 * The key is the OpenAI MCP extensions' `openai/ui`, which Claude reads as
 * well. Claude's conditions: `_meta.ui.resourceUri` is set, the tool is
 * visible to the model, every input is optional (Claude may fill optional
 * ones itself), the title is at most 60 characters, and the name has no `__`,
 * `..` or dot beside an underscore. Only remote connectors qualify, so this is
 * inert in the local extension.
 *
 * get_collection_stats carries it: it takes no input, and its view (every
 * subset with its coverage, each a drill-down) is the natural front page.
 */
export const ENTRY_POINT_UI_META = { ...CHARTS_UI_META, "openai/ui": { entrypoints: [{ type: "global" }] } };

/**
 * `_meta.ui` for a resource's content item. Claude ignores the `resources/list`
 * entry's `_meta.ui` once the content item carries one, so everything lives
 * here: the frame preference, the per-connector sandbox host over HTTP (see
 * uiDomain.ts) and, for the wide view, Claude's `preferredDisplayMode`, an
 * extension outside the spec that other hosts ignore and Claude treats as a
 * one-time hint after the tool succeeds, never as a forced switch.
 */
export function uiContentMeta(options: { wide?: boolean } = {}): { ui: Record<string, unknown> } {
  const domain = currentUiDomain();
  return {
    ui: {
      // Hosts' defaults vary and the chart CSS draws on a transparent
      // background, so ask explicitly for the host's frame rather than
      // rendering as loose ink on the conversation.
      prefersBorder: true,
      ...(domain ? { domain } : {}),
      ...(options.wide ? { preferredDisplayMode: "fullscreen" } : {}),
    },
  };
}

/**
 * Payload tags the app dispatches on (`src/app/views/index.ts`). Every
 * UI-bearing tool stamps one into its result, because `ontoolresult` hands the
 * app a bare CallToolResult with no tool name — and because the app also makes
 * its own follow-up calls, where no host notification exists at all.
 */
export { VIEW } from "../viewContract.js";

export function registerAppResources(server: Server): void {
  // In dev (tsx, no esbuild define) the constant is absent; fall back to a
  // minimal page rather than crashing the whole server on a ReferenceError.
  const html =
    typeof __IWAC_UI_CHARTS__ === "string"
      ? __IWAC_UI_CHARTS__
      : "<!DOCTYPE html><p>IWAC charts: run `npm run build` to bundle the UI.</p>";

  const description =
    "Interactive charts for the IWAC statistics tools: coverage over time, periodical runs, " +
    "country and newspaper comparisons, sentiment breakdowns and collection composition.";
  server.registerResource(
    "iwac-charts",
    CHARTS_UI_URI,
    { title: "IWAC charts", description, mimeType: UI_MIME_TYPE, _meta: { ui: { prefersBorder: true } } },
    async () => ({ contents: [{ uri: CHARTS_UI_URI, mimeType: UI_MIME_TYPE, text: html, _meta: uiContentMeta() }] }),
  );
  server.registerResource(
    "iwac-charts-wide",
    WIDE_UI_URI,
    {
      title: "IWAC charts (full screen)",
      description: `${description} This copy asks Claude to open full screen, for views that need the width.`,
      mimeType: UI_MIME_TYPE,
      _meta: { ui: { prefersBorder: true } },
    },
    async () => ({
      contents: [{ uri: WIDE_UI_URI, mimeType: UI_MIME_TYPE, text: html, _meta: uiContentMeta({ wide: true }) }],
    }),
  );
}
