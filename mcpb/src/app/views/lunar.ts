// get_temporal_distribution (granularity=lunar_month) → the lunar year as bars.
//
// This is the one chart in the suite that a Gregorian axis cannot produce. The
// Hijri year drifts ~11 days against the Gregorian, so over the collection's
// 1961-2025 range a single lunar month smears across all twelve Gregorian ones:
// on `temporal` the Ramadan signal is spread so thin it is invisible. Pooling
// by lunar month instead concentrates it, and the archive's observance rhythm —
// Ramadan, Dhu al-Hijja (hajj and Tabaski), Shawwal (Korité) — appears.
//
// FORM. Twelve fixed named categories whose job is magnitude against a
// meaningful baseline, so: vertical bars plus a dashed even-split reference
// line. The reader's question is "which months are elevated?", and a bar
// against a line answers it directly. A radial "lunar wheel" would evoke the
// cycle better but would trade the one comparison that matters for decorative
// aptness — angle and area read magnitude far worse than length.
//
// Deliberately NOT colour-coded above/below the line. Elevated coverage is not
// "good" and thin coverage is not "bad"; a diverging palette here would assert
// a polarity the data does not carry. One series, one hue, and the line does
// the work.
import { csv, empty, type BasePayload, type ViewResult } from "../shell.js";
import { bar } from "../svg.js";
import { esc, fmtInt } from "../theme.js";
import { carryFilters, type TemporalPayload } from "./temporal.js";

export interface LunarPayload extends TemporalPayload {
  imprecise_date_count?: number;
  month_labels?: Record<string, string>;
}

/** Fallback if the server ever stops sending month_labels. */
const FALLBACK_MONTHS = [
  "Muharram", "Safar", "Rabi' I", "Rabi' II",
  "Jumada I", "Jumada II", "Rajab", "Sha'ban",
  "Ramadan", "Shawwal", "Dhu al-Qa'da", "Dhu al-Hijja",
];

/**
 * Axis text. Twelve labels share ~70 viewBox units each, and "Dhu al-Qa'da"
 * next to "Dhu al-Hijja" overruns that — measured, they collide. Only those two
 * are shortened, and only on the axis: the tooltip, the note and the CSV all
 * keep the full name, so nothing is lost. "Qa'da" and "Hijja" are unambiguous
 * to anyone reading a Hijri axis.
 */
const AXIS_SHORT: Record<string, string> = {
  "Dhu al-Qa'da": "Qa'da",
  "Dhu al-Hijja": "Hijja",
};

/** The months whose deviation from the baseline is worth a direct label. */
function notable(values: number[], baseline: number): Set<number> {
  if (!baseline) return new Set();
  const out = new Set<number>();
  values.forEach((v, i) => {
    if (Math.abs(v / baseline - 1) >= 0.25) out.add(i);
  });
  // Never label more than half the bars — past that it is a number on every
  // bar, which is the thing selective labelling exists to avoid.
  if (out.size > 6) {
    const ranked = values
      .map((v, i) => ({ i, d: Math.abs(v / baseline - 1) }))
      .sort((a, b) => b.d - a.d)
      .slice(0, 4);
    return new Set(ranked.map((r) => r.i));
  }
  return out;
}

export function lunarView(payload: BasePayload): ViewResult {
  const p = payload as LunarPayload;
  const dist = p.distribution ?? {};
  const labels = p.month_labels ?? {};
  const subset = p.subset ?? "articles";

  // Always all twelve, in calendar order, even where a month has no items: a
  // gap in the lunar year is a finding, and dropping the bar would hide it.
  const months = Array.from({ length: 12 }, (_, i) => {
    const key = String(i + 1).padStart(2, "0");
    return { key, name: labels[key] ?? FALLBACK_MONTHS[i], value: dist[key] ?? 0 };
  });
  const values = months.map((m) => m.value);
  const plotted = values.reduce((a, b) => a + b, 0);
  const baseline = plotted / 12;

  const body = plotted
    ? bar({
        categories: months.map((m) => m.name),
        axisLabels: months.map((m) => AXIS_SHORT[m.name] ?? m.name),
        values,
        label: "items",
        reference: baseline
          ? { value: baseline, label: `even split — ${fmtInt(Math.round(baseline))}/month` }
          : undefined,
        labelled: notable(values, baseline),
        ariaLabel: `${subset} per Hijri month`,
        maxTicks: 12,
      })
    : empty("No items with a precise enough date match these filters.");

  // The peak, named — the sentence a reader wants before reading the bars.
  const top = months.reduce((a, b) => (b.value > a.value ? b : a), months[0]);
  const lead =
    plotted && baseline
      ? `${esc(top.name)} leads at ${fmtInt(top.value)} (${Math.round((top.value / baseline - 1) * 100) >= 0 ? "+" : ""}${Math.round((top.value / baseline - 1) * 100)}% vs an even split).`
      : null;

  const imprecise = p.imprecise_date_count
    ? `${fmtInt(p.imprecise_date_count)} matching item${p.imprecise_date_count === 1 ? "" : "s"} carry a date too ` +
      "imprecise for a lunar month (year- or month-only) and are absent from these bars — not zero."
    : null;

  return {
    title: `${subset} per Hijri month`,
    subtitle: `${fmtInt(p.total_matches ?? 0)} matching · ${fmtInt(plotted)} placed in a lunar month`,
    chips: p.filters,
    body,
    notes: [lead, imprecise, p.note],
    actions: [
      {
        // The chart raises the question; this answers it with the actual items.
        id: "peak",
        label: `Read the ${top.name} items`,
        run: (ctx) =>
          ctx.run(subset === "publications" ? "search_publications" : "search_articles", {
            hijri_month: top.key,
            ...carryFilters(p),
          }),
      },
      {
        id: "gregorian",
        label: "Switch to Gregorian years",
        run: (ctx) =>
          ctx.run("get_temporal_distribution", {
            subset,
            granularity: "year",
            ...carryFilters(p),
          }),
      },
      {
        id: "hijri-years",
        label: "Switch to Hijri years",
        run: (ctx) =>
          ctx.run("get_temporal_distribution", {
            subset,
            granularity: "year",
            calendar: "hijri",
            ...carryFilters(p),
          }),
      },
      {
        id: "csv",
        label: "Download CSV",
        run: (ctx) => {
          const rows: unknown[][] = [["hijri_month", "month_name", "count", "vs_even_split_pct"]];
          months.forEach((m) => {
            rows.push([
              Number(m.key),
              m.name,
              m.value,
              baseline ? Math.round((m.value / baseline - 1) * 100) : "",
            ]);
          });
          return ctx.download(`iwac-${subset}-per-hijri-month.csv`, "text/csv", csv(rows));
        },
      },
    ],
  };
}
