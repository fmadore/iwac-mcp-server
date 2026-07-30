// get_temporal_distribution → stacked bars of items per year or month.
//
// The original (and still the most useful) IWAC chart: 30 years of coverage
// read as a shape in one glance, where the same data as 30 JSON keys does not.
import { csv, empty, type BasePayload, type ViewResult } from "../shell.js";
import { legend, stackedBar } from "../svg.js";
import { esc, fmtInt } from "../theme.js";

export interface TemporalPayload extends BasePayload {
  subset?: string;
  granularity?: string;
  calendar?: string;
  group_by?: string;
  filters?: Record<string, unknown>;
  total_matches?: number;
  dated_count?: number;
  undated_count?: number;
  imprecise_date_count?: number;
  distribution?: Record<string, number>;
  distribution_by_group?: Record<string, Record<string, number>>;
}

/** The filters the tool accepts, so a re-call can carry them forward verbatim. */
export function carryFilters(p: TemporalPayload): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p.filters ?? {})) {
    if (v !== null && v !== undefined && v !== "") out[k] = v;
  }
  return out;
}

/** Every bucket key present across one or more series, in sorted order. */
function allBuckets(series: Record<string, number>[]): string[] {
  const keys = new Set<string>();
  for (const s of series) for (const k of Object.keys(s)) keys.add(k);
  return [...keys].sort();
}

export function temporalView(payload: BasePayload): ViewResult {
  const p = payload as TemporalPayload;
  const grouped = p.distribution_by_group;
  const groups = grouped ? Object.keys(grouped).sort() : ["all"];
  const maps = grouped ? groups.map((g) => grouped[g]) : [p.distribution ?? {}];
  const buckets = allBuckets(maps);
  const granularity = p.granularity ?? "year";
  const subset = p.subset ?? "articles";
  const other = granularity === "year" ? "month" : "year";
  // "1445" beside "per year" would read as a Gregorian year; name the calendar
  // wherever the axis is Hijri.
  const hijri = p.calendar === "hijri";
  const axis = hijri ? `Hijri ${granularity}` : granularity;

  const body = buckets.length
    ? stackedBar({
        categories: buckets,
        series: groups.map((label, i) => ({
          label,
          values: buckets.map((b) => maps[i][b] ?? 0),
        })),
        ariaLabel: `${subset} per ${axis}`,
      }) + (grouped ? legend(groups) : "")
    : empty("No dated items match these filters.");

  const undated = p.undated_count
    ? `${fmtInt(p.undated_count)} matching item${p.undated_count === 1 ? "" : "s"} carry no usable date and ` +
      `are not plotted (they are still counted in the total).`
    : null;
  const imprecise = p.imprecise_date_count
    ? `${fmtInt(p.imprecise_date_count)} matching item${p.imprecise_date_count === 1 ? "" : "s"} carry a date too ` +
      "imprecise to convert to a lunar date and are not plotted."
    : null;

  // Cycles none → country → newspaper → none, so one button covers all three
  // states without a second control.
  const nextGroup = p.group_by === "country" ? "newspaper" : p.group_by === "newspaper" ? null : "country";

  return {
    title: `${subset} per ${axis}`,
    subtitle:
      `${fmtInt(p.total_matches ?? 0)} matching · ${fmtInt(p.dated_count ?? 0)} dated` +
      (p.group_by ? ` · grouped by ${esc(p.group_by)}` : ""),
    chips: p.filters,
    body,
    notes: [undated, imprecise, p.note],
    actions: [
      {
        id: "gran",
        label: `Switch to ${other}ly`,
        run: (ctx) =>
          ctx.run("get_temporal_distribution", {
            subset,
            granularity: other,
            ...(hijri ? { calendar: "hijri" } : {}),
            ...(p.group_by ? { group_by: p.group_by } : {}),
            ...carryFilters(p),
          }),
      },
      {
        // The lunar cycle is the reason the Hijri columns exist; one click from
        // any time series reaches it.
        id: "lunar",
        label: hijri ? "Pool by lunar month" : "Switch to the lunar cycle",
        run: (ctx) =>
          ctx.run("get_temporal_distribution", {
            subset,
            granularity: "lunar_month",
            ...carryFilters(p),
          }),
      },
      {
        id: "group",
        label: nextGroup ? `Group by ${nextGroup}` : "Ungroup",
        run: (ctx) =>
          ctx.run("get_temporal_distribution", {
            subset,
            granularity,
            ...(nextGroup ? { group_by: nextGroup } : {}),
            ...carryFilters(p),
          }),
      },
      {
        id: "csv",
        label: "Download CSV",
        run: (ctx) => {
          const header = grouped ? [granularity, p.group_by ?? "group", "count"] : [granularity, "count"];
          const rows: unknown[][] = [header];
          for (const b of buckets) {
            if (grouped) {
              groups.forEach((g, i) => {
                const v = maps[i][b];
                if (v) rows.push([b, g, v]);
              });
            } else {
              rows.push([b, maps[0][b] ?? 0]);
            }
          }
          return ctx.download(`iwac-${subset}-per-${granularity}.csv`, "text/csv", csv(rows));
        },
      },
    ],
  };
}
