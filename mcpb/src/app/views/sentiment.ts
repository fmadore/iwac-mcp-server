// get_sentiment_distribution → the AI polarity and centrality mixes, and —
// with model:"all" — how far the three models agree.
//
// Both vocabularies are ordinal five-point French scales, so the slices go
// round in scale order with a scale-carrying palette (diverging for polarity,
// sequential for centrality). Alphabetical slices in arbitrary hues would throw
// away the ordering, which is most of what these fields say.
//
// The cross-model half is deliberately blunt. When three models score the same
// article and unanimously agree only about half the time, the honest headline
// is the agreement rate, and the confusion matrix showing WHERE they part is
// worth more than any one model's donut.
import { csv, empty, panels, type BasePayload, type ViewResult } from "../shell.js";
import { donut, heatmapMatrix, horizontalBar, legend } from "../svg.js";
import { CENTRALITY_ORDER, fmtInt, fmtPct, ordinalColor, orderBy, POLARITY_ORDER } from "../theme.js";

interface Subjectivity {
  scale?: string;
  mean?: number;
  median?: number;
  scored?: number;
  distribution?: Record<string, number>;
}

interface ModelBlock {
  polarity_distribution?: Record<string, number>;
  centrality_distribution?: Record<string, number>;
  subjectivity?: Subjectivity;
}

export interface SentimentPayload extends BasePayload, ModelBlock {
  model?: string;
  total_articles?: number;
  filters?: Record<string, unknown>;
  models?: string[];
  by_model?: Record<string, ModelBlock>;
  agreement?: {
    field?: string;
    scored_by_all?: number;
    unanimous?: number;
    unanimous_percent?: number;
    pairwise?: Record<string, number>;
  };
  agreement_matrix?: { rows?: string; cols?: string; counts?: Record<string, Record<string, number>> };
}

function ring(dist: Record<string, number> | undefined, scale: string[], centerLabel: string, size = 200): string {
  if (!dist || !Object.keys(dist).length) return "";
  const labels = orderBy(Object.keys(dist), scale);
  const colors = labels.map((l) => ordinalColor(l, scale) ?? "#888");
  return (
    donut({
      slices: labels.map((label, i) => ({ label, value: dist[label], color: colors[i] })),
      centerLabel,
      size,
    }) + legend(labels, colors)
  );
}

const sum = (d: Record<string, number> | undefined): number =>
  Object.values(d ?? {}).reduce((a, b) => a + b, 0);

/** Panels for ONE model: what the tool has always returned. */
function singleModel(p: SentimentPayload, block: ModelBlock, model: string): ViewResult {
  const polarity = ring(block.polarity_distribution, POLARITY_ORDER, "scored");
  const centrality = ring(block.centrality_distribution, CENTRALITY_ORDER, "scored");
  const subj = block.subjectivity;
  const subjectivity = subj?.distribution
    ? donut({
        slices: orderBy(Object.keys(subj.distribution), ["1", "2", "3", "4", "5"]).map((k) => ({
          label: `level ${k}`,
          value: (subj.distribution as Record<string, number>)[k],
        })),
        centerValue: subj.mean === undefined ? undefined : subj.mean.toFixed(2),
        centerLabel: "mean",
        size: 200,
      })
    : "";

  if (!polarity && !centrality && !subjectivity) {
    return {
      title: "AI sentiment",
      chips: p.filters,
      body: empty("This dataset revision carries no AI sentiment columns."),
    };
  }

  const scored = sum(block.polarity_distribution) || sum(block.centrality_distribution);
  const matched = p.total_articles ?? scored;

  return {
    title: `AI sentiment (${model})`,
    subtitle: `${fmtInt(matched)} articles matched · ${fmtInt(scored)} scored`,
    chips: p.filters,
    body: panels([
      { title: "Polarity", body: polarity },
      { title: "Centrality of Islam / Muslims", body: centrality },
      { title: `Subjectivity — ${subj?.scale ?? "1-5"}`, body: subjectivity },
    ]),
    notes: [
      scored < matched
        ? `${fmtInt(matched - scored)} matching articles carry no ${model} score and are not in the rings.`
        : null,
      subj?.scale
        ? `Subjectivity is an ordinal rating on ${subj.scale}, not a proportion — the centre shows its mean, ` +
          `which is ${subj.mean} here, NOT ${fmtPct((subj.mean ?? 0) / 5)}.`
        : null,
      `${model} judgements cover every article regardless of full-text availability, so these shares are not ` +
        "affected by the OCR coverage limit.",
      "Three models scored this corpus independently. Ask for all of them to see how far they agree before " +
        "quoting any single one.",
    ],
    actions: [
      {
        id: "all",
        label: "Compare all three models",
        run: (ctx) =>
          ctx.run("get_sentiment_distribution", {
            model: "all",
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
            `iwac-sentiment-${model}.csv`,
            "text/csv",
            csv([
              ["field", "value", "articles"],
              ...orderBy(Object.keys(block.polarity_distribution ?? {}), POLARITY_ORDER).map((k) => [
                "polarity",
                k,
                block.polarity_distribution?.[k],
              ]),
              ...orderBy(Object.keys(block.centrality_distribution ?? {}), CENTRALITY_ORDER).map((k) => [
                "centrality",
                k,
                block.centrality_distribution?.[k],
              ]),
            ]),
          ),
      },
    ],
  };
}

/** Panels for model:"all": three polarity rings, the agreement rates, and where they part. */
function allModels(p: SentimentPayload): ViewResult {
  const models = p.models ?? Object.keys(p.by_model ?? {});
  const byModel = p.by_model ?? {};

  const rings = models.map((m) => ({
    title: m,
    body: ring(byModel[m]?.polarity_distribution, POLARITY_ORDER, "scored", 170),
  }));

  const agreement = p.agreement;
  const pairs = Object.entries(agreement?.pairwise ?? {});
  const scoredAll = agreement?.scored_by_all ?? 0;
  const pairChart = pairs.length
    ? horizontalBar({
        items: [
          ...pairs.map(([key, n]) => ({ label: key.replace("~", " ↔ "), value: n })),
          { label: "all three", value: agreement?.unanimous ?? 0 },
        ],
        format: (v) => `${fmtInt(v)} (${fmtPct(scoredAll ? v / scoredAll : 0)})`,
        gutter: 180,
        width: 640,
        ariaLabel: "Polarity agreement between models",
      })
    : "";

  // Confusion between the first two models: not "they disagree 29% of the
  // time" but which label one reads where the other reads something else.
  const cm = p.agreement_matrix;
  const rowLabels = cm?.counts ? orderBy(Object.keys(cm.counts), POLARITY_ORDER) : [];
  const colLabels = cm?.counts
    ? orderBy([...new Set(Object.values(cm.counts).flatMap((r) => Object.keys(r)))], POLARITY_ORDER)
    : [];
  const confusion = rowLabels.length
    ? heatmapMatrix({
        rows: rowLabels,
        cols: colLabels,
        // Blank the agreeing diagonal: it holds most of the mass and would
        // flatten the ramp over exactly the disagreements this chart is for.
        values: rowLabels.map((r) =>
          colLabels.map((c) => (r === c ? Number.NaN : (cm?.counts?.[r]?.[c] ?? 0))),
        ),
        gutter: 120,
        ariaLabel: `${cm?.rows} vs ${cm?.cols} polarity`,
      })
    : "";

  return {
    title: "AI sentiment — three models compared",
    subtitle:
      `${fmtInt(p.total_articles ?? 0)} articles · unanimous on polarity for ` +
      `${fmtInt(agreement?.unanimous ?? 0)} (${agreement?.unanimous_percent ?? 0}%)`,
    chips: p.filters,
    body:
      panels(rings) +
      panels([
        { title: "Polarity agreement", body: pairChart },
        { title: `Where they part: ${cm?.rows} (rows) vs ${cm?.cols} (cols)`, body: confusion },
      ]),
    notes: [
      agreement && agreement.unanimous_percent !== undefined
        ? `The three models agree on polarity for ${agreement.unanimous_percent}% of scored articles. Treat that ` +
          `as the confidence floor for any single model's number quoted from this selection.`
        : null,
      confusion
        ? "The confusion matrix blanks its agreeing diagonal, which holds most of the mass; the colour scale is " +
          "over the disagreements only."
        : null,
      "All three models scored every article regardless of full-text availability.",
    ],
    actions: [
      {
        id: "one",
        label: `Back to ${models[0] ?? "gemini"} only`,
        run: (ctx) =>
          ctx.run("get_sentiment_distribution", {
            model: models[0] ?? "gemini",
            ...Object.fromEntries(
              Object.entries(p.filters ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== ""),
            ),
          }),
      },
      {
        id: "csv",
        label: "Download CSV",
        run: (ctx) => {
          const labels = orderBy(
            [...new Set(models.flatMap((m) => Object.keys(byModel[m]?.polarity_distribution ?? {})))],
            POLARITY_ORDER,
          );
          return ctx.download(
            "iwac-sentiment-models.csv",
            "text/csv",
            csv([
              ["model", ...labels, "subjectivity_mean"],
              ...models.map((m) => [
                m,
                ...labels.map((l) => byModel[m]?.polarity_distribution?.[l] ?? 0),
                byModel[m]?.subjectivity?.mean ?? "",
              ]),
            ]),
          );
        },
      },
    ],
  };
}

export function sentimentView(payload: BasePayload): ViewResult {
  const p = payload as SentimentPayload;
  if (p.by_model && Object.keys(p.by_model).length > 1) return allModels(p);
  const model = p.model === "all" ? (p.models?.[0] ?? "gemini") : (p.model ?? "gemini");
  const block: ModelBlock = p.by_model?.[model] ?? p;
  return singleModel(p, block, model);
}
