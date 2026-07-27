// MCP Apps: the one `ui://` resource behind every IWAC chart.
//
// MCP Apps (extension spec 2026-01-26, supported by Claude and Claude Desktop)
// let a tool declare an interactive HTML view that the host renders in a
// sandboxed iframe and feeds the tool result to. A tool opts in with
// `_meta.ui.resourceUri`; the host then fetches that resource and posts the
// result into the frame, and the frame can call tools back through the host.
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

/** `_meta` block a tool spreads in to declare its UI. */
export const CHARTS_UI_META = { ui: { resourceUri: CHARTS_UI_URI } };

/**
 * Payload tags the app dispatches on (`src/app/views/index.ts`). Every
 * UI-bearing tool stamps one into its result, because `ontoolresult` hands the
 * app a bare CallToolResult with no tool name — and because the app also makes
 * its own follow-up calls, where no host notification exists at all.
 */
export const VIEW = {
  temporal: "temporal",
  periodicals: "periodicals",
  countries: "countries",
  newspapers: "newspapers",
  sentiment: "sentiment",
  collection: "collection",
} as const;

export function registerAppResources(server: Server): void {
  // In dev (tsx, no esbuild define) the constant is absent; fall back to a
  // minimal page rather than crashing the whole server on a ReferenceError.
  const html =
    typeof __IWAC_UI_CHARTS__ === "string"
      ? __IWAC_UI_CHARTS__
      : "<!DOCTYPE html><p>IWAC charts: run `npm run build` to bundle the UI.</p>";

  server.registerResource(
    "iwac-charts",
    CHARTS_UI_URI,
    {
      title: "IWAC charts",
      description:
        "Interactive charts for the IWAC statistics tools: coverage over time, periodical runs, " +
        "country and newspaper comparisons, sentiment breakdowns and collection composition.",
      mimeType: UI_MIME_TYPE,
      // Hosts' defaults vary and the chart CSS draws on a transparent
      // background, so ask explicitly for the host's frame rather than
      // rendering as loose ink on the conversation.
      _meta: { prefersBorder: true },
    },
    async () => ({
      contents: [{ uri: CHARTS_UI_URI, mimeType: UI_MIME_TYPE, text: html }],
    }),
  );
}
