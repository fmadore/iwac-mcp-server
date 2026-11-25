import type { ChartModelPayload, ChartOnlyData } from "../../viewContract.js";
import { chartResult, chartViewResult } from "../shared/chartResults.js";
import { z } from "zod";
import { ensureView, query, queryScalarSingle, viewName } from "../../db.js";
import type { Subset } from "../../config.js";
import { CHARTS_UI_META, VIEW } from "../appUi.js";
import { COUNTRIES, errorResult, sourceYears, toolMeta, validateEnum, type Server } from "../_shared.js";
import { aggregateFilters, filterInputs, withScope } from "./shared.js";

const TOPIC_OUTPUT = z.object({
  view: z.string(),
  subset: z.string(),
  filters: z.looseObject({}),
  total_matches: z.number(),
  classified: z.number(),
  topics: z.array(z.looseObject({})),
  // over_time only. The model gets the SHAPE of each band's series; the series
  // itself rides in `_meta` for the chart (see `viewResult`), so `periods` /
  // `series_by_topic` are absent from the model's copy.
  span: z.array(z.string()).optional(),
  trend_by_topic: z.record(z.string(), z.looseObject({})).optional(),
  periods: z.array(z.string()).optional(),
  series_by_topic: z.record(z.string(), z.record(z.string(), z.number())).optional(),
  note: z.string().optional(),
});

export function registerTopicsTools(server: Server): void {
  // === get_topic_distribution =============================================
  server.registerTool(
    "get_topic_distribution",
    {
      ...toolMeta("Topic distribution"),
      description:
        "Counts of offline LDA topic assignments, optionally over time. Topic labels are interpretive model outputs; exact topic_id filters select assignments rather than keyword matches. Reports unclassified coverage.",
      _meta: CHARTS_UI_META,
      inputSchema: z.strictObject({
        subset: z.string().optional().describe("articles (default) | references"),
        ...filterInputs(),
        min_prob: z.number().optional().describe("0-1; keep only assignments at or above this probability"),
        over_time: z.boolean().optional().describe("Also return per-year counts for the leading topics"),
        top_n: z.number().int().optional().describe("Topics given their own band in over_time (default 8, max 15)"),
      }),
      outputSchema: TOPIC_OUTPUT,
    },
    async (args) => {
      const subsetV = validateEnum(args.subset, ["articles", "references"] as const, "subset");
      if (subsetV.err) return errorResult(subsetV.err);
      const subset: Subset = subsetV.canonical ?? "articles";
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);

      const schema = await ensureView(subset);
      if (!schema.has("lda_topic_label")) {
        return errorResult({
          error: `Subset '${subset}' carries no LDA topic columns in this dataset revision`,
          valid_values: ["articles"],
        });
      }

      const filters = aggregateFilters(subset, schema, { ...args, country: country.canonical });
      if (filters.err) return errorResult(filters.err);
      const { echo } = filters;
      return withScope(subset, filters, Boolean(args.keyword), async ({ where, params }) => {
        const total = Number(
          (await queryScalarSingle<number | bigint>(
            `SELECT COUNT(*) FROM ${viewName(subset)} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`,
            params,
          )) ?? 0,
        );

        // Topic rows only: an unclassified article (no label) is not a topic of
        // its own, and -1 is the outlier marker in the pipeline's convention.
        const topicWhere = [...where, `NULLIF(trim(lda_topic_label), '') IS NOT NULL`, `coalesce(lda_topic_id, 0) <> -1`];
        const topicParams = [...params];
        if (typeof args.min_prob === "number" && Number.isFinite(args.min_prob)) {
          topicWhere.push(`coalesce(lda_topic_prob, 0) >= ?`);
          topicParams.push(Math.max(0, Math.min(1, args.min_prob)));
        }
        const topicWhereSql = `WHERE ${topicWhere.join(" AND ")}`;

        // Topic ids restart at 0 in every LDA model, and `references` carries a
        // French and an English model, so a topic is (model, id), not an id.
        const modelSel = schema.has("lda_model_name") ? "NULLIF(trim(lda_model_name), '')" : "NULL";
        const rows = await query(
          `SELECT lda_topic_label AS label, CAST(coalesce(lda_topic_id, -1) AS INTEGER) AS topic_id,
                  ${modelSel} AS topic_model, COUNT(*) AS count, ROUND(AVG(lda_topic_prob), 3) AS avg_prob
           FROM ${viewName(subset)} ${topicWhereSql}
           GROUP BY 1, 2, 3 ORDER BY count DESC, topic_id, topic_model`,
          topicParams,
        );
        const classified = rows.reduce((a, r) => a + Number(r.count), 0);
        // The model is named only when the result spans several: with one, the
        // id already identifies the topic within this selection, and the long
        // model hash would only cost tokens.
        const severalModels = new Set(rows.map((r) => r.topic_model ?? null)).size > 1;

        const payload: ChartModelPayload<"topics"> & Record<string, unknown> = {
          view: VIEW.topics,
          subset,
          filters: { ...echo, min_prob: args.min_prob ?? null },
          total_matches: total,
          classified,
          topics: rows.map((r) => ({
            topic_id: Number(r.topic_id),
            ...(severalModels && r.topic_model != null ? { topic_model: String(r.topic_model) } : {}),
            label: String(r.label),
            count: Number(r.count),
            avg_prob: Number(r.avg_prob),
          })),
        };

        // Set only when over_time produced a series: the chart's copy of it.
        let viewOnly: ChartOnlyData["topics"] | null = null;

        if (args.over_time && schema.has("pub_date")) {
          const topN = Math.max(1, Math.min(15, args.top_n ?? 8));
          const leading = rows.slice(0, topN).map((r) => String(r.label));
          const perYear = await query(
            `SELECT ${sourceYears().bucket} AS bucket,
                    lda_topic_label AS label, COUNT(*) AS c
             FROM ${viewName(subset)} ${topicWhereSql}
             GROUP BY ALL ORDER BY bucket`,
            topicParams,
          );
          // Everything past the top N collapses into one band rather than being
          // dropped: a stacked area whose bands do not sum to the total lies.
          const OTHER = "(other topics)";
          const leadingSet = new Set(leading);
          const series: Record<string, Record<string, number>> = {};
          const periods = new Set<string>();
          for (const r of perYear) {
            if (r.bucket == null) continue;
            const bucket = String(r.bucket);
            periods.add(bucket);
            const key = leadingSet.has(String(r.label)) ? String(r.label) : OTHER;
            series[key] ??= {};
            series[key][bucket] = (series[key][bucket] ?? 0) + Number(r.c);
          }
          const sortedPeriods = [...periods].sort();
          // The full matrix is bands × years, 16 × 65 cells on the unfiltered
          // corpus and ~4.4k tokens, and it exists to be DRAWN. What a model can use
          // from a trend is its shape, so it gets that instead: when each band
          // peaks, and where its mass sits. Reading 65 raw cells to find the
          // maximum is work the server can do once, exactly.
          const shape: NonNullable<ChartModelPayload<"topics">["trend_by_topic"]> = {};
          for (const [label, byYear] of Object.entries(series)) {
            // Code-unit order, as the default sort gives the keys.
            const years = Object.entries(byYear).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
            const first = years[0];
            const last = years.at(-1);
            if (!first || !last) continue;
            let [peak, peakCount] = first;
            for (const [y, c] of years)
              if (c > peakCount) {
                peak = y;
                peakCount = c;
              }
            const totalForBand = years.reduce((a, [, c]) => a + c, 0);
            // Median year by cumulative count: says "half this topic's coverage
            // predates X", which separates a topic that faded from one that is new.
            let running = 0;
            let median = first[0];
            for (const [y, c] of years) {
              running += c;
              if (running >= totalForBand / 2) {
                median = y;
                break;
              }
            }
            shape[label] = {
              total: totalForBand,
              first: first[0],
              last: last[0],
              peak_year: peak,
              peak_count: peakCount,
              median_year: median,
            };
          }
          const firstPeriod = sortedPeriods[0];
          const lastPeriod = sortedPeriods.at(-1);
          payload.span = firstPeriod !== undefined && lastPeriod !== undefined ? [firstPeriod, lastPeriod] : [];
          payload.trend_by_topic = shape;
          payload.note =
            `Per-topic trends are summarised (first/last/peak/median year); the full per-year series is rendered ` +
            `in the chart. Call get_temporal_distribution with a subject or keyword filter for a year-by-year table.`;
          if (rows.length > topN) {
            payload.note =
              `Over-time bands cover the ${topN} largest topics; the remaining ${rows.length - topN} are summed ` +
              `into "${OTHER}" so the bands still total the classified count. ${payload.note}`;
          }
          viewOnly = { periods: sortedPeriods, series_by_topic: series };
        }

        if (severalModels)
          payload.note =
            "Topic ids restart at 0 in each LDA model (topic_model), so select a topic with exact topic_id AND topic_model." +
            (payload.note ? ` ${payload.note}` : "");
        if (classified < total) {
          payload.note =
            `${total - classified} of ${total} matching items carry no topic assignment` +
            (args.min_prob ? ` at min_prob ${args.min_prob}` : "") +
            ` and are not in the distribution.` +
            (payload.note ? ` ${payload.note}` : "");
        }
        return viewOnly ? chartViewResult(payload, viewOnly) : chartResult(payload);
      });
    },
  );
}
