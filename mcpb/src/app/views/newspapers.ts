import { narrowSelection } from "../../selection.js";
import type { NewspapersPayload } from "../../viewContract.js";
// get_newspaper_stats → ranked bars of the titles that carry the corpus.
//
// The tool returns every newspaper (~100). Drawing all of them makes a 2,600px
// strip where the tail is unreadable, so the chart caps the list — and SAYS it
// capped it, with the remainder's share, rather than quietly presenting a top
// slice as the whole picture.
import { csv, empty, type BasePayload, type ViewResult } from "../shell.js";
import { horizontalBar } from "../svg.js";
import { fmtInt, fmtPct } from "../theme.js";

const TOP_N = 25;

export function newspapersView(payload: BasePayload): ViewResult {
  const p = payload as NewspapersPayload;
  const all = [...(p.newspapers ?? [])].sort((a, b) => (b.article_count ?? 0) - (a.article_count ?? 0));
  if (!all.length) {
    return { title: "Newspapers", body: empty("No newspaper matches this filter.") };
  }

  const shown = all.slice(0, TOP_N);
  const hidden = all.length - shown.length;
  const hiddenArticles = all.slice(TOP_N).reduce((a, r) => a + (r.article_count ?? 0), 0);
  const total = p.total_articles ?? all.reduce((a, r) => a + (r.article_count ?? 0), 0);

  return {
    title: "Newspapers by article count",
    subtitle: `${fmtInt(p.total_newspapers ?? all.length)} titles · ${fmtInt(total)} articles`,
    chips: { country: p.country_filter },
    body: horizontalBar({
      items: shown.map((r) => ({
        key: JSON.stringify([r.newspaper, r.country]),
        label: r.newspaper ?? "(untitled)",
        value: r.article_count ?? 0,
        note: [r.country, r.earliest_date ? `${r.earliest_date.slice(0, 4)}–${r.latest_date?.slice(0, 4)}` : null]
          .filter(Boolean)
          .join(", "),
      })),
      clickable: true,
      gutter: 210,
      ariaLabel: "Articles per newspaper",
    }),
    notes: [
      hidden > 0 &&
        `Showing the top ${TOP_N} of ${fmtInt(all.length)} titles. The other ${fmtInt(hidden)} hold ` +
          `${fmtInt(hiddenArticles)} articles (${fmtPct(total ? hiddenArticles / total : 0)} of the total) — ` +
          `the CSV has all of them.`,
      "Click a title to chart its coverage over time.",
    ],
    actions: [
      {
        id: "csv",
        label: "Download CSV",
        run: (ctx) =>
          ctx.download(
            "iwac-newspapers.csv",
            "text/csv",
            csv([
              ["newspaper", "country", "articles", "earliest_date", "latest_date"],
              ...all.map((r) => [r.newspaper, r.country, r.article_count, r.earliest_date, r.latest_date]),
            ]),
          ),
      },
    ],
    wire(root, ctx) {
      const byKey = new Map(shown.map((r) => [JSON.stringify([r.newspaper, r.country]), r]));
      root.querySelectorAll<SVGElement>(".hit[data-key]").forEach((el) => {
        el.addEventListener("click", () => {
          const row = byKey.get(el.getAttribute("data-key") ?? "");
          if (!row?.newspaper) return;
          let selection = narrowSelection({ country: p.country_filter }, "newspaper", row.newspaper);
          for (const country of row.country?.split("|").filter(Boolean) ?? [])
            selection = narrowSelection(selection, "country", country);
          void ctx.run("get_temporal_distribution", { subset: "articles", ...selection });
        });
      });
    },
  };
}

export type { NewspapersPayload } from "../../viewContract.js";
