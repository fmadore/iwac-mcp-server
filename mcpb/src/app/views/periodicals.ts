// list_periodicals → a runs gantt of the Islamic periodical series.
//
// The one chart in the suite that needs no new server work at all: the tool
// already returns exactly title, country, issue count, first year and last
// year. Bar thickness encodes the issue count, because Islam Info's 695 issues
// and a 12-issue series can span the same decade and a plain span would draw
// them identically.
import { csv, empty, type BasePayload, type ViewResult } from "../shell.js";
import { gantt } from "../svg.js";
import { fmtInt } from "../theme.js";

interface Periodical {
  newspaper?: string;
  country?: string;
  issue_count?: number;
  earliest_year?: number;
  latest_year?: number;
}

export interface PeriodicalsPayload extends BasePayload {
  country_filter?: string;
  total_periodicals?: number;
  periodicals?: Periodical[];
}

export function periodicalsView(payload: BasePayload): ViewResult {
  const p = payload as PeriodicalsPayload;
  const all = p.periodicals ?? [];
  const dated = all.filter((r) => Number.isFinite(r.earliest_year) && Number.isFinite(r.latest_year));
  // Longest run first reads as a timeline; the tool orders by issue count.
  const rows = [...dated].sort(
    (a, b) => (a.earliest_year as number) - (b.earliest_year as number) || (a.newspaper ?? "").localeCompare(b.newspaper ?? "", "fr"),
  );
  const undated = all.length - dated.length;
  const issues = all.reduce((a, r) => a + (r.issue_count ?? 0), 0);

  const body = rows.length
    ? gantt({
        rows: rows.map((r) => ({
          label: r.newspaper ?? "(untitled)",
          start: r.earliest_year as number,
          end: r.latest_year as number,
          weight: r.issue_count ?? 1,
          note: r.country,
        })),
        clickable: true,
        ariaLabel: "Periodical runs",
      })
    : empty("No periodical in this selection has a usable year range.");

  return {
    title: "Periodical runs",
    subtitle: `${fmtInt(all.length)} series · ${fmtInt(issues)} issues`,
    chips: { country: p.country_filter },
    body,
    notes: [
      undated > 0 &&
        `${fmtInt(undated)} series carry no usable year and are not plotted (still counted above).`,
      rows.length > 0 && "Bar thickness is the issue count. Click a series to chart its coverage over time.",
    ],
    actions: [
      {
        id: "csv",
        label: "Download CSV",
        run: (ctx) =>
          ctx.download(
            "iwac-periodical-runs.csv",
            "text/csv",
            csv([
              ["series", "country", "issues", "earliest_year", "latest_year"],
              ...all.map((r) => [r.newspaper, r.country, r.issue_count, r.earliest_year, r.latest_year]),
            ]),
          ),
      },
    ],
    wire(root, ctx) {
      root.querySelectorAll<SVGElement>(".hit[data-key]").forEach((el) => {
        el.addEventListener("click", () => {
          const series = el.getAttribute("data-key");
          if (series) void ctx.run("get_temporal_distribution", { subset: "publications", newspaper: series });
        });
      });
    },
  };
}
