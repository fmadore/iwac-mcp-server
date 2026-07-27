// get_semantic_map → a 2-D scatter of a result set, projected by PCA.
//
// The roadmap called this a "stand-in for UMAP" and warned it would look
// different. It does, and the difference is not cosmetic: PCA preserves global
// variance, UMAP preserves local neighbourhoods, so this spreads a corpus along
// its two broadest axes and flattens the fine cluster structure the module's
// semantic landscapes exist to show.
//
// That makes the explained-variance figure part of the chart rather than a
// footnote. Two 768-dimension components typically carry a modest share, and a
// scatter is only worth reading in proportion to how much of the variance it
// actually captures — so the headline says the number, and the view says
// outright when it is too low to trust.
import { csv, empty, type BasePayload, type ViewResult } from "../shell.js";
import { legend, scatter } from "../svg.js";
import { fmtInt, fmtPct } from "../theme.js";

interface Point {
  id?: string;
  title?: string;
  group?: string;
  x?: number;
  y?: number;
}

export interface SemanticMapPayload extends BasePayload {
  subset?: string;
  filters?: Record<string, unknown>;
  total_matches?: number;
  projected?: number;
  color_by?: string;
  explained_variance?: number[];
  points?: Point[];
}

/**
 * Below this, the two axes describe so little that reading distances off the
 * picture misleads.
 *
 * Set from the real corpus, not from a rule of thumb: an unfiltered 400-article
 * projection captures ~18% (13.5% + 4.7%), and a keyword-filtered one ~25%. So
 * the common case IS the weak case, and the caution has to fire there — a
 * threshold under 18% would have quietly exempted exactly the chart most likely
 * to be over-read.
 */
const WEAK_PROJECTION = 0.25;
/** Groups given their own colour; the tail shares one so the legend stays readable. */
const MAX_GROUPS = 12;

export function semanticMapView(payload: BasePayload): ViewResult {
  const p = payload as SemanticMapPayload;
  const points = (p.points ?? []).filter((x) => Number.isFinite(x.x) && Number.isFinite(x.y));
  if (!points.length) {
    return {
      title: "Semantic scatter",
      chips: p.filters,
      body: empty(p.note ?? "No item in this selection carries an embedding."),
    };
  }

  // Largest groups first, so the colours go to the values worth telling apart.
  const counts = new Map<string, number>();
  for (const x of points) if (x.group) counts.set(x.group, (counts.get(x.group) ?? 0) + 1);
  const groups = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_GROUPS)
    .map(([g]) => g);
  const grouped = new Set(groups);

  const explained = p.explained_variance ?? [0, 0];
  const captured = (explained[0] ?? 0) + (explained[1] ?? 0);

  const body =
    scatter({
      points: points.map((x) => ({
        x: x.x as number,
        y: x.y as number,
        label: x.title || (x.id ?? ""),
        group: x.group && grouped.has(x.group) ? x.group : undefined,
      })),
      groups,
      clickable: false,
      ariaLabel: "Items projected onto their first two principal components",
    }) + (groups.length > 1 ? legend(groups) : "");

  return {
    title: `Semantic scatter — ${p.subset ?? "articles"}`,
    subtitle:
      `${fmtInt(p.projected ?? points.length)} of ${fmtInt(p.total_matches ?? 0)} items projected · ` +
      `these two axes carry ${fmtPct(captured)} of the variance`,
    chips: { ...p.filters, coloured_by: p.color_by },
    body,
    notes: [
      `PC1 carries ${fmtPct(explained[0] ?? 0)} and PC2 ${fmtPct(explained[1] ?? 0)} of the variance.` +
        (captured < WEAK_PROJECTION
          ? ` That leaves ${fmtPct(1 - captured)} in the other dimensions, so distances here are a weak signal: ` +
            `items drawn close together are not necessarily similar. Read this as a rough spread, not as clusters.`
          : ""),
      "This is PCA, not UMAP. It preserves the broadest axes of variation rather than local neighbourhoods, so " +
        "it is not the semantic landscape published on islam.zmo.de and should not be compared to it.",
      p.note,
      counts.size > groups.length
        ? `${counts.size - groups.length} smaller ${p.color_by ?? "group"} values share the default colour; ` +
          `filter to compare them.`
        : null,
    ],
    actions: [
      {
        id: "csv",
        label: "Download CSV",
        run: (ctx) =>
          ctx.download(
            "iwac-semantic-map.csv",
            "text/csv",
            csv([
              ["id", "title", p.color_by ?? "group", "pc1", "pc2"],
              ...points.map((x) => [x.id, x.title, x.group, x.x, x.y]),
            ]),
          ),
      },
    ],
  };
}
