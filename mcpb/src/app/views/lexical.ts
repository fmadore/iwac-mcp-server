// get_lexical_metrics → how the press writes, by year, newspaper or country.
//
// Three metrics on three axes rather than one chart, because they do not share
// a scale and should not share an axis: readability runs 0-100, MATTR 0-1, and
// word count into the thousands.
//
// Two things this view refuses to do, both because they would be wrong:
//   * normalise MATTR by word count, or bin by length. It is a moving-average
//     type-token ratio and is ALREADY length-robust; that is the whole reason
//     the pipeline uses it over raw TTR.
//   * present the non-French items as unreadable. Readability is scored against
//     a French lexicon, so the server leaves those rows out of that metric and
//     this view says how many, rather than ranking them at the bottom.
import { csv, empty, panels, type BasePayload, type ViewResult } from "../shell.js";
import { columns, horizontalBar } from "../svg.js";
import { fmtInt, fmtNum } from "../theme.js";

interface Group {
  group?: string;
  items?: number;
  readability_avg?: number;
  readability_median?: number;
  readability_n?: number;
  mattr_avg?: number;
  mattr_median?: number;
  words_avg?: number;
  words_median?: number;
}

export interface LexicalPayload extends BasePayload {
  group_by?: string;
  filters?: Record<string, unknown>;
  total_matches?: number;
  groups?: Group[];
  metrics?: Record<string, { label?: string; higher_is?: string; range?: string }>;
  readability_excluded?: number;
}

const SERIES: { key: keyof Group; title: string; places: number }[] = [
  { key: "readability_avg", title: "Readability (French, higher = easier)", places: 1 },
  { key: "mattr_avg", title: "Lexical richness (MATTR)", places: 3 },
  { key: "words_avg", title: "Words per item", places: 0 },
];

export function lexicalView(payload: BasePayload): ViewResult {
  const p = payload as LexicalPayload;
  const groups = (p.groups ?? []).filter((g) => (g.items ?? 0) > 0);
  const groupBy = p.group_by ?? "year";

  if (!groups.length) {
    return {
      title: "Press language",
      chips: p.filters,
      body: empty("No item in this selection carries the lexical metric columns."),
    };
  }

  const labels = groups.map((g) => g.group ?? "");
  // A year axis is ordered and dense, so it reads as a trend; newspapers and
  // countries are an unordered set and read as a ranking.
  const draw = (key: keyof Group, places: number): string => {
    const values = groups.map((g) => Number(g[key] ?? 0));
    if (!values.some((v) => v > 0)) return "";
    const format = (v: number) => fmtNum(v, places);
    return groupBy === "year"
      ? columns({
          categories: labels,
          series: [{ label: String(key), values }],
          format,
          height: 200,
          width: 780,
          ariaLabel: String(key),
        })
      : horizontalBar({
          items: groups.map((g, i) => ({ label: labels[i], value: values[i], note: `${fmtInt(g.items ?? 0)} items` })),
          format,
          gutter: 190,
          width: 620,
          ariaLabel: String(key),
        });
  };

  return {
    title: `Press language by ${groupBy}`,
    subtitle: `${fmtInt(groups.length)} ${groupBy === "year" ? "years" : `${groupBy}s`} · ${fmtInt(p.total_matches ?? 0)} items`,
    chips: p.filters,
    body: panels(SERIES.map((s) => ({ title: s.title, body: draw(s.key, s.places) }))),
    notes: [
      p.readability_excluded
        ? `${fmtInt(p.readability_excluded)} non-French item${p.readability_excluded === 1 ? "" : "s"} ` +
          `are excluded from the readability average — a French-lexicon score says nothing useful about them. ` +
          `They are still counted in MATTR and word length, which need no lexicon.`
        : null,
      "MATTR is a moving-average type-token ratio and is already length-robust: comparing it across groups of " +
        "different article lengths is valid, and normalising it by word count would not be.",
      "These columns exist only for items whose full text ships in this public dataset, so the averages describe " +
        "that subset rather than the whole corpus.",
      p.note,
    ],
    actions: [
      {
        id: "group",
        label: groupBy === "year" ? "Group by newspaper" : "Group by year",
        run: (ctx) =>
          ctx.run("get_lexical_metrics", {
            group_by: groupBy === "year" ? "newspaper" : "year",
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
            `iwac-press-language-by-${groupBy}.csv`,
            "text/csv",
            csv([
              [groupBy, "items", "readability_avg", "readability_n", "mattr_avg", "words_avg"],
              ...groups.map((g) => [
                g.group,
                g.items,
                g.readability_avg,
                g.readability_n,
                g.mattr_avg,
                g.words_avg,
              ]),
            ]),
          ),
      },
    ],
  };
}
