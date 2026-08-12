// The one constant shared by the server and the browser app.
//
// These are two separate bundles, `src/index.ts` (node) and `src/app/charts.ts`
// (browser, IIFE), and neither may import the other's tree: the app would drag
// in DuckDB, the server would drag in the DOM. This module has no imports at
// all, so both can depend on it without pulling anything behind it. Compare
// `UI_MIME_TYPE` in tools/appUi.ts, which is duplicated and kept honest by a
// test because the value it mirrors lives in a devDependency.

/**
 * `_meta` key on a tool RESULT under which chart-only data travels.
 *
 * MCP Apps hands the view the whole `CallToolResult` (the spec types the
 * tool-result notification's params as `CallToolResult`, `_meta` included),
 * while the model reads only `content` and `structuredContent`. That asymmetry
 * is a channel: data a chart needs but a model cannot use (per-point scatter
 * coordinates, a per-year-per-topic matrix) can ride here instead of being
 * billed to every conversation that triggers the chart.
 *
 * The name follows the spec's `<prefix>/<name>` form on a domain we control.
 * `modelcontextprotocol.io/` and `mcp.dev/` are reserved; `islam.zmo.de` is the
 * collection's own host.
 *
 * Rule for what may travel here: ONLY data that is redundant for reasoning.
 * Anything the model would need in order to answer the question the user
 * actually asked stays in `structuredContent`, in summarised form if the raw
 * series is too big. A host without MCP Apps shows the user no chart, so
 * whatever moves here is invisible to them: it must never be the answer.
 */
export const VIEW_DATA_META_KEY = "islam.zmo.de/viewData";
