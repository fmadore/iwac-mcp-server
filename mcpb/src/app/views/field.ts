// get_field_distribution → ranked values of one field, plus how its coverage
// moves over time.
//
// One view for what the roadmap listed as two apps: "place ranking" and "press
// bylines" are the same chart pointed at `spatial` and `author`. The
// over-time panel is what makes the bylines case work — the interesting fact
// about `author` is not who tops the list but that the signed SHARE climbs as
// the press professionalises, which a ranking alone cannot show.
import { csv, empty, panels, type BasePayload, type ViewResult } from "../shell.js";
import { columns, horizontalBar } from "../svg.js";
import { fmtInt, fmtPct } from "../theme.js";

interface Value {
  value?: string;
  count?: number;
}

export interface FieldPayload extends BasePayload {
  subset?: string;
  field?: string;
  filters?: Record<string, unknown>;
  total_matches?: number;
  items_with_value?: number;
  distinct_values?: number;
  values?: Value[];
  other_values?: number;
  coverage_by_year?: Record<string, { total?: number; with_value?: number }>;
}

/** How the field reads in a heading. */
const FIELD_TITLES: Record<string, string> = {
  subject: "Subjects",
  spatial: "Places named",
  author: "Bylines",
  language: "Languages",
  newspaper: "Newspapers",
  country: "Countries",
};

export function fieldView(payload: BasePayload): ViewResult {
  const p = payload as FieldPayload;
  const field = p.field ?? "subject";
  const values = (p.values ?? []).filter((v) => (v.count ?? 0) > 0);
  const total = p.total_matches ?? 0;
  const filled = p.items_with_value ?? 0;

  if (!values.length) {
    return {
      title: FIELD_TITLES[field] ?? field,
      chips: p.filters,
      body: empty(`No item in this selection carries a '${field}' value.`),
    };
  }

  const ranking = horizontalBar({
    items: values.map((v) => ({ label: v.value ?? "", value: v.count ?? 0 })),
    clickable: true,
    gutter: 200,
    ariaLabel: `Items per ${field}`,
  });

  // Coverage over time: the SHARE with a value, not the count, because the
  // count just retraces the corpus's own volume curve.
  const coverage = p.coverage_by_year ?? {};
  const years = Object.keys(coverage).sort();
  const share = years.length
    ? columns({
        categories: years,
        series: [
          {
            label: "share with a value",
            values: years.map((y) => {
              const c = coverage[y];
              return c?.total ? (c.with_value ?? 0) / c.total : 0;
            }),
          },
        ],
        format: fmtPct,
        height: 220,
        ariaLabel: `Share of items carrying a ${field}, per year`,
      })
    : "";

  return {
    title: FIELD_TITLES[field] ?? field,
    subtitle:
      `${fmtInt(p.distinct_values ?? values.length)} distinct values · ` +
      `${fmtInt(filled)} of ${fmtInt(total)} items carry one (${fmtPct(total ? filled / total : 0)})`,
    chips: p.filters,
    body: share
      ? panels([
          { title: `Top ${field}`, body: ranking },
          { title: "Share of items with a value, per year", body: share },
        ])
      : ranking,
    notes: [
      p.note,
      p.other_values
        ? `Showing the top ${values.length}; ${fmtInt(p.other_values)} further values are not plotted.`
        : null,
      share
        ? null
        : "Ask for over_time to see how the share of items carrying this field moves across the years.",
      `Click a value to chart the coverage that carries it.`,
    ],
    actions: [
      {
        id: "time",
        label: share ? "Hide the coverage trend" : "Show coverage over time",
        run: (ctx) =>
          ctx.run("get_field_distribution", {
            field,
            subset: p.subset,
            ...(share ? {} : { over_time: true }),
            ...Object.fromEntries(
              Object.entries(p.filters ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== ""),
            ),
          }),
      },
      {
        id: "csv",
        label: "Download CSV",
        run: (ctx) =>
          ctx.download(
            `iwac-${field}-ranking.csv`,
            "text/csv",
            csv([[field, "items"], ...values.map((v) => [v.value, v.count])]),
          ),
      },
    ],
    wire(root, ctx) {
      root.querySelectorAll<SVGElement>(".hit[data-key]").forEach((el) => {
        el.addEventListener("click", () => {
          const value = el.getAttribute("data-key");
          if (!value) return;
          // `subject`, `country` and `newspaper` are real filters on the
          // temporal tool; anything else has to go through the keyword path.
          const args: Record<string, unknown> =
            field === "subject" || field === "country" || field === "newspaper"
              ? { subset: p.subset ?? "articles", [field]: value }
              : { subset: p.subset ?? "articles", keyword: value };
          void ctx.run("get_temporal_distribution", args);
        });
      });
    },
  };
}
