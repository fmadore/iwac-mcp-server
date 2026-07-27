// get_collection_stats → what the collection is made of, and how much of it is
// actually readable.
//
// The treemap answers "how big is each subset"; the gauges answer the question
// the tool's own description insists on — full text ships only for items whose
// content is public on islam.zmo.de, so a keyword count is a floor, not a
// census. Putting the two side by side is the point: 12,287 articles with 61%
// full text is a different corpus from 12,287 articles.
import { csv, empty, panels, type BasePayload, type ViewResult } from "../shell.js";
import { gauge, treemap } from "../svg.js";
import { fmtInt, fmtPct } from "../theme.js";

interface Coverage {
  with_fulltext?: number;
  total?: number;
  percent?: number;
}

export interface CollectionPayload extends BasePayload {
  collection_name?: string;
  subset_counts?: Record<string, number>;
  failed_subsets?: string[];
  total_records?: number;
  fulltext_coverage?: Record<string, Coverage>;
  fulltext_note?: string;
  articles_by_country?: Record<string, number>;
  newspaper_count?: number;
  date_range?: { earliest?: string; latest?: string };
}

export function collectionView(payload: BasePayload): ViewResult {
  const p = payload as CollectionPayload;
  const counts = p.subset_counts ?? {};
  const subsets = Object.entries(counts)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);

  if (!subsets.length) {
    return { title: "Collection", body: empty("No subset reported a row count.") };
  }

  const coverage = Object.entries(p.fulltext_coverage ?? {}).filter(([, c]) => (c.total ?? 0) > 0);

  return {
    title: p.collection_name ?? "Islam West Africa Collection",
    subtitle:
      `${fmtInt(p.total_records ?? 0)} records across ${subsets.length} subsets` +
      (p.newspaper_count ? ` · ${fmtInt(p.newspaper_count)} newspapers` : "") +
      (p.date_range?.earliest
        ? ` · articles ${p.date_range.earliest.slice(0, 4)}–${p.date_range.latest?.slice(0, 4)}`
        : ""),
    body:
      treemap({
        items: subsets.map(([label, value]) => ({ label, value })),
        clickable: true,
        height: 300,
        ariaLabel: "Records per subset",
      }) +
      (coverage.length
        ? panels(
            coverage.map(([subset, c]) => ({
              title: subset,
              body: gauge({
                value: (c.with_fulltext ?? 0) / (c.total ?? 1),
                // Prefer the tool's own rounded percent: a reader looking at
                // both the chart and the JSON must not see 61% and 60.9%.
                label: `${
                  c.percent === undefined ? fmtPct((c.with_fulltext ?? 0) / (c.total ?? 1)) : `${c.percent}%`
                } full text`,
                caption: `${fmtInt(c.with_fulltext ?? 0)} / ${fmtInt(c.total ?? 0)}`,
                width: 240,
              }),
            })),
          )
        : ""),
    notes: [
      coverage.length > 0 && p.fulltext_note,
      p.failed_subsets?.length ? `Could not load: ${p.failed_subsets.join(", ")}.` : null,
      "Click a subset to chart its coverage over time.",
    ],
    actions: [
      {
        id: "csv",
        label: "Download CSV",
        run: (ctx) =>
          ctx.download(
            "iwac-collection-stats.csv",
            "text/csv",
            csv([
              ["subset", "records", "with_fulltext", "fulltext_percent"],
              ...subsets.map(([s, v]) => {
                const c = p.fulltext_coverage?.[s];
                return [s, v, c?.with_fulltext ?? "", c?.percent ?? ""];
              }),
            ]),
          ),
      },
    ],
    wire(root, ctx) {
      root.querySelectorAll<SVGElement>(".hit[data-key]").forEach((el) => {
        el.addEventListener("click", () => {
          const subset = el.getAttribute("data-key");
          // `index` has no pub_date — its first/last_occurrence mean something
          // else entirely — so it is deliberately not a temporal drill-down.
          if (subset && subset !== "index") void ctx.run("get_temporal_distribution", { subset });
        });
      });
    },
  };
}
