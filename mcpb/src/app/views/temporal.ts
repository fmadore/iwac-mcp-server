import type { TemporalPayload } from "../../viewContract.js";
import { selectionFrom } from "../../selection.js";
import { csv, empty, type BasePayload, type ViewResult } from "../shell.js";
import { columns, legend } from "../svg.js";
import { esc, fmtInt } from "../theme.js";

export function carryFilters(p: TemporalPayload): Record<string, unknown> {
  return { ...selectionFrom(p.filters) };
}
export function temporalView(payload: BasePayload): ViewResult {
  const p = payload as TemporalPayload,
    grouped = p.distribution_by_group;
  const groups = [...new Set([...Object.keys(grouped ?? { all: 0 }), ...Object.keys(p.denominators ?? {})])].sort();
  const maps = grouped ?? { all: p.distribution ?? {} };
  const buckets = [
    ...new Set([...Object.values(maps), ...Object.values(p.denominators ?? {})].flatMap((s) => Object.keys(s))),
  ].sort();
  const granularity = p.granularity ?? "year",
    subset = p.subset ?? "articles",
    other = granularity === "year" ? "month" : "year";
  const axis = `${p.calendar === "hijri" ? "Hijri " : ""}${granularity}`;
  const normalized = Boolean(p.normalize_by);
  const value = (g: string, b: string) =>
    normalized
      ? p.denominators?.[g]?.[b]
        ? (100 * (maps[g]?.[b] ?? 0)) / p.denominators[g][b]
        : Number.NaN
      : (maps[g]?.[b] ?? 0);
  const args = {
    subset,
    granularity,
    calendar: p.calendar,
    ...(p.group_by ? { group_by: p.group_by } : {}),
    ...(p.normalize_by ? { normalize_by: p.normalize_by } : {}),
    ...carryFilters(p),
  };
  const rows: unknown[][] = [[axis, "group", "count", "denominator", "percent"]];
  for (const b of buckets)
    for (const g of groups)
      rows.push([
        b,
        g,
        maps[g]?.[b] ?? 0,
        p.denominators?.[g]?.[b] ?? "",
        normalized && Number.isFinite(value(g, b)) ? value(g, b).toFixed(2) : "",
      ]);
  const table = `<details><summary>Counts and denominators</summary><div class="scroll"><table>${rows.map((r, i) => `<tr>${r.map((v) => `<${i ? "td" : "th"}>${esc(v)}</${i ? "td" : "th"}>`).join("")}</tr>`).join("")}</table></div></details>`;
  const nextGroup = p.group_by === "country" ? "newspaper" : p.group_by === "newspaper" ? null : "country";
  return {
    title: `${subset} per ${axis}${normalized ? " — share (%)" : ""}`,
    subtitle: `${fmtInt(p.total_matches ?? 0)} matching · ${fmtInt(p.dated_count ?? 0)} dated`,
    chips: p.filters,
    body:
      (buckets.length
        ? columns({
            categories: buckets,
            series: groups.map((label) => ({ label, values: buckets.map((b) => value(label, b)) })),
            mode: normalized ? "grouped" : "stacked",
            ariaLabel: `${subset} per ${axis}${normalized ? ", percent of denominator" : ""}`,
          }) + (groups.length > 1 ? legend(groups) : "")
        : empty("No dated items match these filters.")) + table,
    notes: [
      p.undated_count
        ? `${fmtInt(p.undated_count)} matching items carry no usable date and are absent from the plot.`
        : undefined,
      p.imprecise_date_count
        ? `${fmtInt(p.imprecise_date_count)} dates are too imprecise for this calendar.`
        : undefined,
      normalized
        ? `Denominator: ${p.normalize_by === "searchable" ? "items with available body text" : "all archived items"} in the same country/outlet/date scope, with thematic filters removed. Missing denominator is unavailable, not zero.`
        : undefined,
      p.note,
    ],
    actions: [
      {
        id: "gran",
        label: `Switch to ${other}ly`,
        run: (ctx) => ctx.run("get_temporal_distribution", { ...args, granularity: other }),
      },
      {
        id: "lunar",
        label: "Show lunar cycle",
        run: (ctx) => ctx.run("get_temporal_distribution", { ...args, granularity: "lunar_month", calendar: "hijri" }),
      },
      {
        id: "group",
        label: nextGroup ? `Group by ${nextGroup}` : "Ungroup",
        run: (ctx) => {
          const { group_by: _old, ...rest } = args;
          return ctx.run("get_temporal_distribution", { ...rest, ...(nextGroup ? { group_by: nextGroup } : {}) });
        },
      },
      {
        id: "normalize",
        label: normalized ? "Show raw counts" : "Normalize by archived scope",
        run: (ctx) => {
          const { normalize_by: _old, ...rest } = args;
          return ctx.run("get_temporal_distribution", { ...rest, ...(!normalized ? { normalize_by: "scope" } : {}) });
        },
      },
      {
        id: "searchable",
        label: "Normalize within available body text",
        run: (ctx) => ctx.run("get_temporal_distribution", { ...args, normalize_by: "searchable" }),
      },
      {
        id: "csv",
        label: "Download CSV",
        run: (ctx) =>
          ctx.download(
            `iwac-${subset}-per-${granularity}.csv`,
            "text/csv",
            csv(
              normalized
                ? rows
                : grouped
                  ? [[axis, p.group_by ?? "group", "count"], ...rows.slice(1).map((r) => r.slice(0, 3))]
                  : [[axis, "count"], ...rows.slice(1).map((r) => [r[0], r[2]])],
            ),
          ),
      },
    ],
  };
}
export type { TemporalPayload } from "../../viewContract.js";
