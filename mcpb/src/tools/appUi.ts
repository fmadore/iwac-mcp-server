// MCP Apps: the `ui://` resource behind the coverage chart.
//
// MCP Apps (extension spec 2026-01-26, supported by Claude and Claude Desktop)
// let a tool declare an interactive HTML view that the host renders in a
// sandboxed iframe and feeds the tool result to. A tool opts in with
// `_meta.ui.resourceUri`; the host then fetches that resource and posts the
// result into the frame, and the frame can call tools back through the host.
//
// Only get_temporal_distribution opts in, deliberately: it is the one tool whose
// answer is a shape rather than a list, and a bar chart of 30 years of coverage
// is genuinely easier to read than 30 JSON keys. Everything else stays text —
// a table rendered as a table is not worth an iframe.
//
// The declaration is inert on hosts without MCP Apps support: `_meta` is ignored
// and the tool returns exactly the same content and structuredContent as before.
// That is why this needs no capability negotiation and no second tool.
import type { Server } from "./_shared.js";

/** Injected by esbuild (scripts/bundle.mjs): the whole chart UI as one
 * self-contained HTML document, inline CSS and JS included, because MCP App
 * resources render under a deny-by-default CSP. */
declare const __IWAC_UI_COVERAGE__: string;

/** MIME type the MCP Apps extension defines for a UI resource. */
const UI_MIME_TYPE = "text/html+mcp";

export const COVERAGE_UI_URI = "ui://iwac/coverage.html";

/** `_meta` block a tool spreads in to declare its UI. */
export const COVERAGE_UI_META = { ui: { resourceUri: COVERAGE_UI_URI } };

export function registerAppResources(server: Server): void {
  // In dev (tsx, no esbuild define) the constant is absent; fall back to a
  // minimal page rather than crashing the whole server on a ReferenceError.
  const html =
    typeof __IWAC_UI_COVERAGE__ === "string"
      ? __IWAC_UI_COVERAGE__
      : "<!DOCTYPE html><p>IWAC coverage chart: run `npm run build` to bundle the UI.</p>";

  server.registerResource(
    "coverage-chart",
    COVERAGE_UI_URI,
    {
      title: "IWAC coverage chart",
      description:
        "Interactive bar chart of get_temporal_distribution results: items per year or month, " +
        "optionally stacked by country or newspaper.",
      mimeType: UI_MIME_TYPE,
    },
    async () => ({
      contents: [{ uri: COVERAGE_UI_URI, mimeType: UI_MIME_TYPE, text: html }],
    }),
  );
}
