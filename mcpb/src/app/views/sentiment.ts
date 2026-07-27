// get_sentiment_distribution → donuts of the AI polarity and centrality mixes.
//
// Both vocabularies are ordinal five-point French scales, so the slices go
// round in scale order with a scale-carrying palette (diverging for polarity,
// sequential for centrality) — alphabetical slices in arbitrary hues would
// throw away the ordering, which is most of what these fields say.
import { csv, empty, panels, type BasePayload, type ViewResult } from "../shell.js";
import { donut, legend } from "../svg.js";
import { CENTRALITY_ORDER, fmtInt, ordinalColor, orderBy, POLARITY_ORDER } from "../theme.js";

export interface SentimentPayload extends BasePayload {
  model?: string;
  total_articles?: number;
  filters?: Record<string, unknown>;
  polarity_distribution?: Record<string, number>;
  centrality_distribution?: Record<string, number>;
}

function ring(dist: Record<string, number> | undefined, scale: string[], centerLabel: string): string {
  if (!dist || !Object.keys(dist).length) return "";
  const labels = orderBy(Object.keys(dist), scale);
  const colors = labels.map((l) => ordinalColor(l, scale) ?? "#888");
  return (
    donut({
      slices: labels.map((label, i) => ({ label, value: dist[label], color: colors[i] })),
      centerLabel,
      size: 200,
    }) + legend(labels, colors)
  );
}

export function sentimentView(payload: BasePayload): ViewResult {
  const p = payload as SentimentPayload;
  const polarity = ring(p.polarity_distribution, POLARITY_ORDER, "scored");
  const centrality = ring(p.centrality_distribution, CENTRALITY_ORDER, "scored");
  const model = p.model ?? "gemini";

  if (!polarity && !centrality) {
    return {
      title: "AI sentiment",
      chips: p.filters,
      body: empty("This dataset revision carries no AI sentiment columns."),
    };
  }

  // The donuts total the SCORED articles, which can be fewer than the matched
  // ones; stating both stops the chart from reading as a census of the filter.
  const scored = Object.values(p.polarity_distribution ?? p.centrality_distribution ?? {}).reduce(
    (a, b) => a + b,
    0,
  );
  const matched = p.total_articles ?? scored;

  return {
    title: `AI sentiment (${model})`,
    subtitle: `${fmtInt(matched)} articles matched · ${fmtInt(scored)} scored`,
    chips: p.filters,
    body: panels([
      { title: "Polarity", body: polarity },
      { title: "Centrality of Islam / Muslims", body: centrality },
    ]),
    notes: [
      scored < matched &&
        `${fmtInt(matched - scored)} matching articles carry no ${model} score and are not in the rings.`,
      `${model} judgements cover every article regardless of full-text availability, so these shares are not ` +
        "affected by the OCR coverage limit.",
    ],
    actions: [
      {
        id: "csv",
        label: "Download CSV",
        run: (ctx) =>
          ctx.download(
            `iwac-sentiment-${model}.csv`,
            "text/csv",
            csv([
              ["field", "value", "articles"],
              ...orderBy(Object.keys(p.polarity_distribution ?? {}), POLARITY_ORDER).map((k) => [
                "polarity",
                k,
                p.polarity_distribution?.[k],
              ]),
              ...orderBy(Object.keys(p.centrality_distribution ?? {}), CENTRALITY_ORDER).map((k) => [
                "centrality",
                k,
                p.centrality_distribution?.[k],
              ]),
            ]),
          ),
      },
    ],
  };
}
