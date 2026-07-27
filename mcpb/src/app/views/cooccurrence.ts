// get_cooccurrence → which values of a field are discussed together.
//
// The matrix and a ranked pair list side by side, because they answer different
// questions: the matrix shows the whole structure at a glance (blocks of
// mutually-co-occurring subjects), the list names the specific strongest ties.
//
// The diagonal is each value's own count, which is much larger than any
// off-diagonal cell, so colouring the whole matrix on one scale would wash out
// exactly the cells the chart exists to show. This view blanks the diagonal for
// the colour scale and reports it separately.
import { csv, empty, panels, type BasePayload, type ViewOptions, type ViewResult } from "../shell.js";
import { forceGraph, heatmapMatrix, horizontalBar } from "../svg.js";
import { clip, fmtInt } from "../theme.js";

interface Pair {
  a?: string;
  b?: string;
  count?: number;
}

export interface CooccurrencePayload extends BasePayload {
  subset?: string;
  field?: string;
  filters?: Record<string, unknown>;
  total_matches?: number;
  values?: { value?: string; count?: number }[];
  matrix?: number[][];
  top_pairs?: Pair[];
}

/**
 * Edges worth drawing in the network. A complete graph over 15 values is 105
 * lines and reads as a solid blob, so only the pairs above a share of the
 * strongest tie are kept — and the view says how many it dropped.
 */
const EDGE_THRESHOLD = 0.12;

export function cooccurrenceView(payload: BasePayload, options: ViewOptions = {}): ViewResult {
  const p = payload as CooccurrencePayload;
  const field = p.field ?? "subject";
  const values = (p.values ?? []).map((v) => v.value ?? "");
  const matrix = p.matrix ?? [];

  if (!values.length || !matrix.length) {
    return {
      title: "Co-occurrence",
      chips: p.filters,
      body: empty(`No item in this selection carries two or more '${field}' values.`),
    };
  }

  // Blank the diagonal: it is the value's own total, an order of magnitude
  // above any pair count, and leaving it in flattens the rest of the ramp.
  const offDiagonal = matrix.map((row, i) => row.map((v, j) => (i === j ? Number.NaN : v)));

  const asNetwork = options.layout === "network";

  // Upper triangle only; the matrix is symmetric so both halves are one edge.
  const allEdges = values
    .flatMap((_, i) => values.slice(i + 1).map((__, k) => ({ source: i, target: i + 1 + k, weight: matrix[i][i + 1 + k] })))
    .filter((e) => e.weight > 0);
  const strongest = Math.max(1, ...allEdges.map((e) => e.weight));
  const edges = allEdges.filter((e) => e.weight >= strongest * EDGE_THRESHOLD);

  const network = asNetwork
    ? forceGraph({
        nodes: values.map((label, i) => ({ label, weight: matrix[i][i] })),
        edges,
        clickable: true,
        ariaLabel: `${field} co-mention network`,
      })
    : "";

  const grid = asNetwork
    ? ""
    : heatmapMatrix({
        rows: values,
        cols: values,
        values: offDiagonal,
        clickable: true,
        gutter: 150,
        cell: values.length > 20 ? 20 : 26,
        ariaLabel: `${field} co-occurrence`,
      });

  const pairs = (p.top_pairs ?? []).filter((x) => (x.count ?? 0) > 0);
  const pairChart = pairs.length
    ? horizontalBar({
        items: pairs.map((x) => ({ label: `${clip(x.a ?? "", 18)} + ${clip(x.b ?? "", 18)}`, value: x.count ?? 0 })),
        gutter: 250,
        width: 620,
        ariaLabel: "Strongest co-occurring pairs",
      })
    : "";

  return {
    title: `${field} co-occurrence`,
    subtitle: `top ${values.length} values · ${fmtInt(p.total_matches ?? 0)} items in scope`,
    chips: p.filters,
    body: panels([
      { title: asNetwork ? "Co-mention network" : "Co-mention matrix", body: asNetwork ? network : grid },
      { title: "Strongest pairs", body: pairChart },
    ]),
    notes: [
      p.note,
      asNetwork
        ? `The layout is computed in the browser over these ${values.length} values only — it is NOT a layout of ` +
          `the whole co-mention graph, which has far more nodes than an in-page force simulation can place. ` +
          `Ask for a different top_n to change what is in it.`
        : "The diagonal is left blank in the heatmap: each value's own count dwarfs every pair count and would " +
          "flatten the colour scale. Its value is in the ranking, not here.",
      asNetwork && allEdges.length > edges.length
        ? `${allEdges.length - edges.length} of ${allEdges.length} pairs are below ` +
          `${Math.round(EDGE_THRESHOLD * 100)}% of the strongest tie and are not drawn; a complete graph at this ` +
          `size reads as a solid blob. The matrix view has all of them.`
        : null,
      "Click a value to chart the coverage tagged with it.",
    ],
    actions: [
      {
        id: "layout",
        label: asNetwork ? "Show as matrix" : "Show as network",
        // No round trip: this is a second reading of the payload already here.
        run: (ctx) => ctx.setOption("layout", asNetwork ? "matrix" : "network"),
      },
      {
        id: "csv",
        label: "Download CSV",
        run: (ctx) =>
          ctx.download(
            `iwac-${field}-cooccurrence.csv`,
            "text/csv",
            csv([
              ["", ...values],
              ...values.map((v, i) => [v, ...matrix[i]]),
            ]),
          ),
      },
    ],
    wire(root, ctx) {
      root.querySelectorAll<SVGElement>(".hit[data-key]").forEach((el) => {
        el.addEventListener("click", () => {
          const value = el.getAttribute("data-key");
          if (!value) return;
          const args: Record<string, unknown> =
            field === "subject"
              ? { subset: p.subset ?? "articles", subject: value }
              : { subset: p.subset ?? "articles", keyword: value };
          void ctx.run("get_temporal_distribution", args);
        });
      });
    },
  };
}
