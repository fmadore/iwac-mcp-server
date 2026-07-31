// get_country_comparison → article volume per country, plus how the AI polarity
// mix differs between them.
//
// Two charts rather than one grouped bar: article counts run to five figures
// and newspaper counts to two, so a shared axis would flatten the newspaper
// series to an invisible sliver. Volume goes in a ranked bar (newspaper count
// and date range ride along as the tooltip), and the polarity mix goes in a
// separate 100%-stacked chart, where the question is composition, not size.
import { csv, empty, panels, type BasePayload, type ViewResult } from "../shell.js";
import { horizontalBar, legend, stackedBar } from "../svg.js";
import { fmtInt, fmtPct, ordinalColor, orderBy, POLARITY_ORDER } from "../theme.js";

interface Country {
  country?: string;
  article_count?: number;
  newspaper_count?: number;
  date_range?: { earliest?: string; latest?: string };
  polarity?: Record<string, number>;
}

export interface CountriesPayload extends BasePayload {
  total_countries?: number;
  /** Which model produced the polarity buckets — three scored the corpus. */
  polarity_model?: string;
  countries?: Country[];
}

export function countriesView(payload: BasePayload): ViewResult {
  const p = payload as CountriesPayload;
  const rows = (p.countries ?? []).filter((c) => (c.article_count ?? 0) > 0);
  if (!rows.length) {
    return { title: "Countries compared", body: empty("No country carries any articles in this dataset revision.") };
  }

  const total = rows.reduce((a, c) => a + (c.article_count ?? 0), 0);
  const names = rows.map((c) => c.country ?? "(none)");

  const volume = horizontalBar({
    items: rows.map((c) => ({
      label: c.country ?? "(none)",
      value: c.article_count ?? 0,
      note: [
        c.newspaper_count ? `${fmtInt(c.newspaper_count)} newspapers` : null,
        c.date_range?.earliest ? `${c.date_range.earliest.slice(0, 4)}–${c.date_range.latest?.slice(0, 4)}` : null,
      ]
        .filter(Boolean)
        .join(", "),
    })),
    clickable: true,
    gutter: 130,
    height: rows.length * 26 + 16,
    rowHeight: 26,
    ariaLabel: "Articles per country",
  });

  // Polarity, normalised per country: the interesting question is whether Niger
  // reads more negative than Benin, which raw counts hide behind volume.
  const labels = orderBy(
    [...new Set(rows.flatMap((c) => Object.keys(c.polarity ?? {})))],
    POLARITY_ORDER,
  );
  const model = p.polarity_model ?? "one AI model";
  const polarity = labels.length
    ? stackedBar({
        categories: names,
        series: labels.map((label) => ({
          label,
          color: ordinalColor(label, POLARITY_ORDER),
          values: rows.map((c) => {
            const bucket = c.polarity ?? {};
            const sum = Object.values(bucket).reduce((a, b) => a + b, 0);
            return sum ? (bucket[label] ?? 0) / sum : 0;
          }),
        })),
        format: fmtPct,
        height: 240,
        ariaLabel: "AI polarity mix per country",
      }) + legend(labels, labels.map((l) => ordinalColor(l, POLARITY_ORDER) ?? "#888"))
    : "";

  const scored = rows.filter((c) => Object.keys(c.polarity ?? {}).length).length;

  return {
    title: "Countries compared",
    subtitle: `${fmtInt(rows.length)} countries · ${fmtInt(total)} articles`,
    body: panels([
      { title: "Articles", body: volume },
      ...(polarity ? [{ title: `Polarity mix per country (${model})`, body: polarity }] : []),
    ]),
    notes: [
      "Click a country to chart its coverage over time.",
      polarity &&
        scored < rows.length &&
        `Polarity shown for ${scored} of ${rows.length} countries; the rest carry no scored articles.`,
      polarity &&
        `Polarity is ${model}'s judgement over every article, full text or not — it is not affected by the OCR ` +
          "coverage limit. Two other models scored the same articles and read some of them differently.",
    ],
    actions: [
      {
        id: "csv",
        label: "Download CSV",
        run: (ctx) =>
          ctx.download(
            "iwac-country-comparison.csv",
            "text/csv",
            csv([
              ["country", "articles", "newspapers", "earliest", "latest", ...labels],
              ...rows.map((c) => [
                c.country,
                c.article_count,
                c.newspaper_count,
                c.date_range?.earliest,
                c.date_range?.latest,
                ...labels.map((l) => c.polarity?.[l] ?? 0),
              ]),
            ]),
          ),
      },
    ],
    wire(root, ctx) {
      root.querySelectorAll<SVGElement>(".hit[data-key]").forEach((el) => {
        el.addEventListener("click", () => {
          const country = el.getAttribute("data-key");
          if (country && country !== "(none)") void ctx.run("get_temporal_distribution", { country });
        });
      });
    },
  };
}
