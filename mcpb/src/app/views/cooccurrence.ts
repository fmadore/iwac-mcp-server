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
import { csv, empty, panels, type BasePayload, type ViewResult } from "../shell.js";
import { heatmapMatrix, horizontalBar } from "../svg.js";
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

export function cooccurrenceView(payload: BasePayload): ViewResult {
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

  const grid = heatmapMatrix({
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
      { title: "Co-mention matrix", body: grid },
      { title: "Strongest pairs", body: pairChart },
    ]),
    notes: [
      p.note,
      "The diagonal is left blank in the heatmap: each value's own count dwarfs every pair count and would " +
        "flatten the colour scale. Its value is in the ranking, not here.",
      "Click a cell to chart the coverage tagged with the row's value.",
    ],
    actions: [
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
