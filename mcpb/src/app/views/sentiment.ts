// get_sentiment_distribution → the AI polarity and centrality mixes, and —
// with model:"all" — how far the panel's models agree.
//
// All three vocabularies are ordinal French scales, so the slices go round in
// scale order with a scale-carrying palette (diverging for polarity, sequential
// for centrality and subjectivity). Alphabetical slices in arbitrary hues would
// throw away the ordering, which is most of what these fields say.
//
// The cross-model half is deliberately blunt. When five models score the same
// article and all five agree only about a third of the time, the honest headline
// is the agreement rate, and the confusion matrix showing WHERE they part is
// worth more than any one model's donut.
//
// Every count here comes from the payload's own `models` array, never from a
// number written into the prose: the panel gained a fourth member in v3.2.0 and a
// fifth in v3.4.0, and a chart that says "three models" over five rings is worse
// than one that says nothing. The same rule now covers coverage: the members do
// not all score the same articles, so a ring's own denominator is read from its
// `coverage` block rather than assumed to be the corpus.
import { csv, empty, panels, type BasePayload, type ViewResult } from "../shell.js";
import { donut, heatmapMatrix, horizontalBar, legend } from "../svg.js";
import {
  CENTRALITY_ORDER,
  fmtInt,
  fmtPct,
  ordinalColor,
  orderBy,
  POLARITY_ORDER,
  SUBJECTIVITY_ORDER,
} from "../theme.js";

interface Subjectivity {
  scale?: string;
  /** Derived by ranking the labels 1-5, not a stored score — hence the name. */
  mean_rank?: number;
  median_rank?: number;
  rank_scale?: string;
  scored?: number;
  unscored?: number;
  distribution?: Record<string, number>;
  caveat?: string;
}

interface MedianRank {
  scored?: number;
  mean?: number;
  median?: number;
  distribution?: Record<string, number>;
  note?: string;
  caveat?: string;
}

interface ModelBlock {
  polarity_distribution?: Record<string, number>;
  centrality_distribution?: Record<string, number>;
  /** Consensus only: subjectivity arrives as a float median, never as labels. */
  subjectivity_median_rank?: MedianRank;
  disputed?: Record<string, number | string>;
  note?: string;
  /** Per-scale scored counts. The distributions drop their unscored key, so a
   * model that answered fewer articles is invisible without this. */
  coverage?: Record<string, number>;
  model_caveat?: string;
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
  consensus?: ModelBlock;
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

/** "polarite 429 · centralite 465 · subjectivite 3,184" from the disputed block,
 * skipping the `any` roll-up and the prose note it ships alongside. */
function fmtDisputed(disputed: Record<string, number | string>): string {
  return Object.entries(disputed)
    .filter(([k, v]) => k !== "any" && k !== "note" && typeof v === "number")
    .map(([k, v]) => `${k} ${fmtInt(v as number)}`)
    .join(" · ");
}

/** Panels for ONE model: what the tool has always returned. */
function singleModel(p: SentimentPayload, block: ModelBlock, model: string): ViewResult {
  const polarity = ring(block.polarity_distribution, POLARITY_ORDER, "scored");
  const centrality = ring(block.centrality_distribution, CENTRALITY_ORDER, "scored");
  const subj = block.subjectivity;
  const subjectivity = subj?.distribution
    ? ring(subj.distribution, SUBJECTIVITY_ORDER, "scored")
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
  // The consensus is not a model, so the prose below must not treat it as one:
  // nothing "scored" these articles, and telling the reader to go compare the
  // models is advice they have already taken.
  const isConsensus = model === "consensus";
  const median = block.subjectivity_median_rank;

  return {
    title: isConsensus ? "AI sentiment — panel consensus" : `AI sentiment (${model})`,
    subtitle: isConsensus
      ? `${fmtInt(matched)} articles matched · ${fmtInt(scored)} carry a majority`
      : `${fmtInt(matched)} articles matched · ${fmtInt(scored)} scored`,
    chips: p.filters,
    body: panels([
      { title: "Polarity", body: polarity },
      { title: "Centrality of Islam / Muslims", body: centrality },
      { title: "Subjectivity", body: subjectivity },
    ]),
    notes: [
      isConsensus && scored < matched
        ? `${fmtInt(matched - scored)} matching articles reached NO majority on polarity and are not in the ` +
          "rings. That is a split panel, not a missing judgement."
        : scored < matched
          ? `${fmtInt(matched - scored)} matching articles carry no ${model} score and are not in the rings.`
          : null,
      isConsensus && median?.median !== undefined
        ? `Subjectivity is the MEDIAN of the votes cast (mean ${median.mean}, median ${median.median} on a ` +
          `1-5 scale), so it resolves for ${fmtInt(median.scored ?? 0)} articles where a majority label could ` +
          "not form. It is not a label and must not be read as one."
        : null,
      isConsensus && block.disputed ? `Split panel by field — ${fmtDisputed(block.disputed)}.` : null,
      isConsensus ? (block.note ?? null) : null,
      // The caveat travels with the chart, not just the JSON: a donut is the
      // easiest thing here to screenshot and quote out of context, and this is
      // the field least able to survive that.
      subj?.caveat ? `Subjectivity — ${subj.caveat}` : null,
      subj?.mean_rank !== undefined
        ? `Subjectivity is an ordinal label, ranked ${subj.rank_scale ?? "1-5"} only to average it: ` +
          `mean rank ${subj.mean_rank}, median ${subj.median_rank}. That is a position on a five-point ` +
          `scale, NOT ${fmtPct(subj.mean_rank / 5)} subjective.`
        : null,
      isConsensus
        ? null
        : `${model} scored articles whether or not their full text ships, so these shares are not affected by ` +
          "the OCR coverage limit — the reconciliation above is the only coverage gap.",
      "Several models scored this corpus independently. Ask for all of them to see how far they agree before " +
        "quoting any single one.",
    ],
    actions: [
      {
        id: "all",
        label: "Compare all models",
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
              ...orderBy(Object.keys(subj?.distribution ?? {}), SUBJECTIVITY_ORDER).map((k) => [
                "subjectivity",
                k,
                subj?.distribution?.[k],
              ]),
            ]),
          ),
      },
    ],
  };
}

/** Panels for model:"all": one polarity ring per model, the agreement rates, and where they part. */
function allModels(p: SentimentPayload): ViewResult {
  const models = p.models ?? Object.keys(p.by_model ?? {});
  const byModel = p.by_model ?? {};

  // The members do not all score the same articles. Annotate only the ones that
  // fall short of the panel's best coverage: five rings each captioned with an
  // identical denominator is noise, and one ring silently drawn on 200 fewer
  // articles than its neighbour is a misreading waiting to happen.
  const coverageOf = (m: string) => byModel[m]?.coverage?.polarity;
  const fullest = Math.max(0, ...models.map((m) => coverageOf(m) ?? 0));
  const shortOf = (m: string) => {
    const c = coverageOf(m);
    return c !== undefined && fullest > 0 && c < fullest ? fullest - c : 0;
  };
  const rings = models.map((m) => ({
    title: shortOf(m) ? `${m} · ${fmtInt(shortOf(m))} fewer articles scored` : m,
    body: ring(byModel[m]?.polarity_distribution, POLARITY_ORDER, "scored", 170),
  }));
  const shortModels = models.filter((m) => shortOf(m) > 0);

  // The panel's conclusion sits in its OWN panel row rather than among the
  // model rings: drawn beside them it would read as a sixth annotator, which is
  // the one thing it is not.
  const consensus = p.consensus;
  const consensusRing = ring(consensus?.polarity_distribution, POLARITY_ORDER, "decided", 170);

  const agreement = p.agreement;
  const pairs = Object.entries(agreement?.pairwise ?? {});
  const scoredAll = agreement?.scored_by_all ?? 0;
  const pairChart = pairs.length
    ? horizontalBar({
        items: [
          ...pairs.map(([key, n]) => ({ label: key.replace("~", " ↔ "), value: n })),
          { label: `all ${models.length}`, value: agreement?.unanimous ?? 0 },
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
    title: `AI sentiment — ${models.length} models compared`,
    subtitle:
      `${fmtInt(p.total_articles ?? 0)} articles · unanimous on polarity for ` +
      `${fmtInt(agreement?.unanimous ?? 0)} (${agreement?.unanimous_percent ?? 0}%)`,
    chips: p.filters,
    body:
      panels(rings) +
      (consensusRing
        ? panels([{ title: "Panel consensus — majority of the votes actually cast", body: consensusRing }])
        : "") +
      panels([
        { title: "Polarity agreement", body: pairChart },
        { title: `Where they part: ${cm?.rows} (rows) vs ${cm?.cols} (cols)`, body: confusion },
      ]),
    notes: [
      agreement && agreement.unanimous_percent !== undefined
        ? `All ${models.length} models agree on polarity for ${agreement.unanimous_percent}% of scored articles. ` +
          `Treat that as the confidence floor for any single model's number quoted from this selection.`
        : null,
      confusion
        ? "The confusion matrix blanks its agreeing diagonal, which holds most of the mass; the colour scale is " +
          "over the disagreements only."
        : null,
      // The consensus is counted on a DIFFERENT set from the agreement bars
      // above it, and the two are easy to read as one number if nothing says so.
      consensusRing && consensus?.coverage?.polarity !== undefined
        ? `The consensus ring is not drawn on the same articles as the bars above: a majority needs only over ` +
          `half the votes CAST, so it decides ${fmtInt(consensus.coverage.polarity)} articles where the ` +
          `agreement base holds ${fmtInt(scoredAll)}. No model produced it.`
        : null,
      consensusRing && consensus?.disputed
        ? `The panel split, reaching no majority, on ${fmtDisputed(consensus.disputed)}.`
        : null,
      shortModels.length
        ? `The panel does not cover one common set: ${shortModels.join(", ")} scored fewer articles than the ` +
          `rest. Every bar above is measured on the ${fmtInt(scoredAll)} articles all ${models.length} models ` +
          `judged, so pairs that exclude the short members are still counted on that reduced base.`
        : `All ${models.length} scored the same articles, whether or not their full text ships — see ` +
          `scored_by_all above for how many carry all ${models.length} judgements.`,
    ],
    actions: [
      {
        id: "one",
        label: `Back to ${models[0]} only`,
        run: (ctx) =>
          ctx.run("get_sentiment_distribution", {
            model: models[0],
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
              ["model", ...labels, "subjectivity_mean_rank"],
              ...models.map((m) => [
                m,
                ...labels.map((l) => byModel[m]?.polarity_distribution?.[l] ?? 0),
                byModel[m]?.subjectivity?.mean_rank ?? "",
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
  // The model id comes from the payload rather than a default here: the view
  // must never name a model that did not produce the numbers it is drawing.
  const model = (p.model === "all" ? p.models?.[0] : p.model) ?? Object.keys(p.by_model ?? {})[0] ?? "the AI model";
  const block: ModelBlock = p.by_model?.[model] ?? p;
  return singleModel(p, block, model);
}
