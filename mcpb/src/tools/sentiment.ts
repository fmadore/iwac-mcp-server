import { z } from "zod";
import { ensureView, q, query, queryOne, queryScalarSingle, viewName, type Bindable } from "../db.js";
import { CHARTS_UI_META, VIEW } from "./appUi.js";
import {
  capOffset,
  CENTRALITY_VALUES,
  COUNTRIES,
  colsFor,
  countryParam,
  DEFAULT_SENTIMENT_MODEL,
  errorResult,
  foldedEquals,
  likeFilterIfExists,
  pipeValueFilterIfExists,
  POLARITY_VALUES,
  pubDateOrder,
  resolveLimit,
  resolveSentimentModel,
  rowsToMap,
  runListQuery,
  retiredSentimentModel,
  SENTIMENT_MODEL_IDS,
  SENTIMENT_MODELS,
  sentimentCols,
  structuredResult,
  subjectivityRank,
  SUBJECTIVITY_VALUES,
  textResult,
  toolMeta,
  validateEnum,
  type SentimentModel,
  type Server,
} from "./_shared.js";

/**
 * Shipped with every subjectivity block. Measured on the generation-2 pilot
 * (2026-07-29): pairwise κ 0.093-0.470, and one model reproduced its own answer
 * on a re-run only 47% of the time. That is weak enough that a reader who gets
 * the number without the caveat will over-read it, and the number is cheap
 * enough to ship that withholding it entirely is worse.
 */
const SUBJECTIVITY_CAVEAT =
  "Weakest of the three scales: inter-model agreement κ 0.093-0.470 and self-consistency as low as 47% on " +
  "re-run. Treat as weak evidence and never report it without this caveat; polarity and centrality are far stronger.";

// Small, stable envelope → worth a structured-output contract. Distributions
// are optional because the sentiment columns may be absent from a revision.
const SENTIMENT_DISTRIBUTION_OUTPUT = z.object({
  view: z.string(),
  model: z.string(),
  total_articles: z.number(),
  filters: z.looseObject({}),
  polarity_distribution: z.record(z.string(), z.number()).optional(),
  centrality_distribution: z.record(z.string(), z.number()).optional(),
  subjectivity: z.looseObject({}).optional(),
  models: z.array(z.string()).optional(),
  by_model: z.record(z.string(), z.looseObject({})).optional(),
  agreement: z.looseObject({}).optional(),
  agreement_matrix: z.looseObject({}).optional(),
});

export function registerSentimentTools(server: Server): void {
  // === search_by_sentiment =================================================
  server.registerTool(
    "search_by_sentiment",
    {
      ...toolMeta("Filter articles by AI sentiment"),
      description:
        `Filter articles by ${DEFAULT_SENTIMENT_MODEL.id} sentiment labels (accent/case-insensitive exact ` +
        "match). One model's reading, not a consensus — two other models scored the same articles and often " +
        "disagree; get_sentiment_distribution with model:\"all\" shows by how much. `subjectivity` is much the " +
        "weakest of the three scales, so treat a set selected on it as a lead to read rather than as a finding.",
      inputSchema: z.object({
        polarity: z
          .string()
          .optional()
          .describe("Très positif | Positif | Neutre | Négatif | Très négatif | Non applicable"),
        centrality: z
          .string()
          .optional()
          .describe("Très central | Central | Secondaire | Marginal | Non abordé"),
        subjectivity: z
          .string()
          .optional()
          .describe(
            `${SUBJECTIVITY_VALUES.join(" | ")} — least to most subjective. Unscored where the model ` +
              "answered Non abordé, so this filter also excludes those.",
          ),
        country: countryParam(),
        subject: z.string().optional(),
        limit: z.number().int().optional().describe("Default 20, max 100"),
        offset: z.number().int().optional(),
      }),
    },
    async (args) => {
      const schema = await ensureView("articles");
      const polarity = validateEnum(args.polarity, POLARITY_VALUES, "polarity");
      if (polarity.err) return errorResult(polarity.err);
      const centrality = validateEnum(args.centrality, CENTRALITY_VALUES, "centrality");
      if (centrality.err) return errorResult(centrality.err);
      const subjectivity = validateEnum(args.subjectivity, SUBJECTIVITY_VALUES, "subjectivity");
      if (subjectivity.err) return errorResult(subjectivity.err);
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);
      const limit = resolveLimit(args.limit, 20, 100);
      const offset = capOffset(args.offset);
      const cols = sentimentCols(DEFAULT_SENTIMENT_MODEL);
      const where: string[] = [];
      const params: Bindable[] = [];

      // A requested filter whose column this revision lacks is an error, not a
      // dropped clause: silently returning the unfiltered corpus reads as "every
      // article is Très négatif". Reachable on a cache predating the
      // generation-2 sentiment columns.
      for (const f of [
        { field: "polarity", value: polarity.canonical, column: cols.polarity },
        { field: "centrality", value: centrality.canonical, column: cols.centrality },
        { field: "subjectivity", value: subjectivity.canonical, column: cols.subjectivity },
      ]) {
        if (!f.value) continue;
        if (!schema.has(f.column)) {
          return errorResult({
            error: `This dataset revision has no ${f.column} column, so ${f.field} cannot be filtered`,
          });
        }
        where.push(foldedEquals(f.column));
        params.push(f.value);
      }
      pipeValueFilterIfExists(schema, where, params, "country", country.canonical);
      pipeValueFilterIfExists(schema, where, params, "subject", args.subject);

      return textResult(
        await runListQuery({
          subset: "articles",
          where,
          params,
          cols: colsFor("articles", schema, "sentiment"),
          orderBy: pubDateOrder(schema),
          limit,
          offset,
        }),
      );
    },
  );

  // === get_sentiment_distribution =========================================
  server.registerTool(
    "get_sentiment_distribution",
    {
      ...toolMeta("Aggregate AI sentiment"),
      description:
        "Aggregate AI polarity, centrality and subjectivity across a filter set. Three models scored the " +
        `corpus independently — ${SENTIMENT_MODEL_IDS.join(", ")} — so model:"all" returns each one's ` +
        "distribution plus how often they AGREE. Treat disagreement as a fact about the judgement rather than " +
        "noise: in a set where the three models split on polarity, no single model's number should be quoted " +
        "alone. All three scales are ordinal French labels; subjectivity is much the weakest and ships a caveat " +
        "to quote with it. Articles were scored whether or not their full text ships, so these shares are not " +
        "subject to the OCR coverage limit; compare scored_by_all against total_articles for the residual gap " +
        "(the ~51 non-francophone articles are unscored by design).",
      _meta: CHARTS_UI_META,
      inputSchema: z.object({
        country: countryParam(),
        newspaper: z.string().optional(),
        subject: z.string().optional(),
        model: z
          .string()
          .optional()
          .describe(
            `${SENTIMENT_MODEL_IDS.join(" | ")} | all — default ${DEFAULT_SENTIMENT_MODEL.id}; ` +
              '"all" adds the cross-model agreement. The vendor shorthands chatgpt/mistral/deepseek also ' +
              "resolve to the model that ran. The generation-1 models (gemini-3-flash-preview, gpt-5-mini, " +
              "ministral-14b-2512) are no longer served and return an error rather than a substitute.",
          ),
      }),
      outputSchema: SENTIMENT_DISTRIBUTION_OUTPUT,
    },
    async (args) => {
      const schema = await ensureView("articles");
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);

      // Not validateEnum: the vendor shorthands are accepted but are not part of
      // the canonical vocabulary, so resolution and the valid_values list differ.
      const raw = args.model?.trim();
      const wantsAll = raw !== undefined && raw.toLowerCase() === "all";
      const resolved = raw === undefined || raw === "" ? DEFAULT_SENTIMENT_MODEL : resolveSentimentModel(raw);
      if (!wantsAll && !resolved) {
        // A retired handle names a real annotator that this server no longer
        // serves, so it gets its own error rather than the generic one — and is
        // never quietly re-pointed at the same vendor's successor, which scored
        // the corpus differently.
        const retired = raw ? retiredSentimentModel(raw) : undefined;
        return errorResult({
          error: retired
            ? `Model '${raw}' is ${retired}. This server serves the generation-2 campaign only.`
            : `Invalid model: ${raw}`,
          valid_values: [...SENTIMENT_MODEL_IDS, "all"],
        });
      }
      const requested = wantsAll ? "all" : (resolved as SentimentModel).id;
      const where: string[] = [];
      const params: Bindable[] = [];
      pipeValueFilterIfExists(schema, where, params, "country", country.canonical);
      likeFilterIfExists(schema, where, params, "newspaper", args.newspaper);
      pipeValueFilterIfExists(schema, where, params, "subject", args.subject);
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      // Only the models this revision actually carries. Asking for a missing
      // one is an error naming the real list, not a silent all-zero envelope.
      const available = SENTIMENT_MODELS.filter((m) => schema.has(sentimentCols(m).polarity));
      if (!available.length) {
        return errorResult({ error: "This dataset revision carries no AI sentiment columns" });
      }
      if (!wantsAll && !available.includes(resolved as SentimentModel)) {
        return errorResult({
          error: `Model '${requested}' is not in this dataset revision`,
          valid_values: available.map((m) => m.id),
        });
      }
      const models: SentimentModel[] = wantsAll ? [...available] : [resolved as SentimentModel];

      const total = Number(
        (await queryScalarSingle<number | bigint>(
          `SELECT COUNT(*) FROM ${viewName("articles")} ${whereSql}`,
          params,
        )) ?? 0,
      );
      const payload: Record<string, unknown> = {
        view: VIEW.sentiment,
        model: requested,
        total_articles: total,
        filters: {
          country: country.canonical ?? null,
          newspaper: args.newspaper ?? null,
          subject: args.subject ?? null,
        },
      };

      /** Polarity, centrality and subjectivity for one model, under this filter. */
      const distributionsFor = async (model: SentimentModel): Promise<Record<string, unknown>> => {
        const cols = sentimentCols(model);
        const out: Record<string, unknown> = {};
        if (schema.has(cols.polarity)) {
          out.polarity_distribution = rowsToMap(
            await query(
              `SELECT ${q(cols.polarity)} AS k, COUNT(*) AS c FROM ${viewName("articles")} ${whereSql} GROUP BY 1`,
              params,
            ),
          );
        }
        if (schema.has(cols.centrality)) {
          out.centrality_distribution = rowsToMap(
            await query(
              `SELECT ${q(cols.centrality)} AS k, COUNT(*) AS c FROM ${viewName("articles")} ${whereSql} GROUP BY 1`,
              params,
            ),
          );
        }
        // Subjectivity is an ordinal LABEL, so the distribution is the answer and
        // the scalars are derived: mean_rank/median_rank come from ranking the
        // five labels 1-5 in TypeScript, not from anything stored. They are named
        // `_rank` for that reason — a bare `mean: 2.12` reads as "21% subjective"
        // to anyone assuming a normalised score, and here it is not even a score.
        if (schema.has(cols.subjectivity)) {
          const distribution = rowsToMap(
            await query(
              `SELECT ${q(cols.subjectivity)} AS k, COUNT(*) AS c FROM ${viewName("articles")} ${whereSql} GROUP BY 1`,
              params,
            ),
          );
          const ranked = Object.entries(distribution)
            .map(([label, n]) => ({ rank: subjectivityRank(label), n }))
            .filter((e): e is { rank: number; n: number } => e.rank !== undefined)
            .sort((a, b) => a.rank - b.rank);
          const scored = Object.values(distribution).reduce((a, b) => a + b, 0);
          if (scored) {
            const rankedN = ranked.reduce((a, e) => a + e.n, 0);
            // Median of an ordinal: the rank at which the cumulative count
            // crosses the halfway mark, not an average of the two middle values
            // — halfway between "Plutôt objectif" and "Mixte" is not a label.
            let cumulative = 0;
            let median: number | undefined;
            for (const e of ranked) {
              cumulative += e.n;
              if (cumulative >= rankedN / 2) {
                median = e.rank;
                break;
              }
            }
            out.subjectivity = {
              scale: `${SUBJECTIVITY_VALUES.join(" | ")} (ordinal, least to most subjective)`,
              scored,
              unscored: total - scored,
              distribution,
              ...(rankedN
                ? {
                    mean_rank: Math.round((ranked.reduce((a, e) => a + e.rank * e.n, 0) / rankedN) * 1000) / 1000,
                    median_rank: median,
                    rank_scale: "1 = Très objectif … 5 = Très subjectif; derived here, not stored",
                  }
                : {}),
              caveat: SUBJECTIVITY_CAVEAT,
            };
          }
        }
        return out;
      };

      if (!wantsAll) {
        Object.assign(payload, await distributionsFor(resolved as SentimentModel));
        return structuredResult(payload);
      }

      const byModel: Record<string, unknown> = {};
      for (const m of models) byModel[m.id] = await distributionsFor(m);
      payload.models = models.map((m) => m.id);
      payload.by_model = byModel;

      if (models.length > 1) {
        // Agreement is measured on polarity: the field most likely to differ
        // between models and the one whose number gets quoted the most.
        const cols = models.map((m) => q(sentimentCols(m).polarity));
        const scoredExpr = cols.map((c) => `NULLIF(trim(${c}), '') IS NOT NULL`).join(" AND ");
        const sameExpr = cols.slice(1).map((c) => `${cols[0]} = ${c}`).join(" AND ");
        const pairExprs = models.flatMap((a, i) =>
          models.slice(i + 1).map((b) => ({
            key: `${a.id}~${b.id}`,
            sql: `COUNT(*) FILTER (WHERE ${q(sentimentCols(a).polarity)} = ${q(sentimentCols(b).polarity)} AND ${scoredExpr})`,
          })),
        );
        const row = await queryOne(
          `SELECT COUNT(*) FILTER (WHERE ${scoredExpr}) AS scored,
                  COUNT(*) FILTER (WHERE ${scoredExpr} AND ${sameExpr}) AS unanimous,
                  ${pairExprs.map((p, i) => `${p.sql} AS pair_${i}`).join(", ")}
           FROM ${viewName("articles")} ${whereSql}`,
          params,
        );
        const scoredN = Number(row?.scored ?? 0);
        const unanimous = Number(row?.unanimous ?? 0);
        const pairwise: Record<string, number> = {};
        pairExprs.forEach((p, i) => {
          pairwise[p.key] = Number(row?.[`pair_${i}`] ?? 0);
        });
        payload.agreement = {
          field: "polarity",
          scored_by_all: scoredN,
          unanimous,
          unanimous_percent: scoredN ? Math.round((unanimous / scoredN) * 100) : 0,
          pairwise,
        };

        // Where the disagreement actually goes: how the first model's label
        // maps onto the second's. "They disagree 46% of the time" is much less
        // useful than "mistral-small-2603 reads as Très positif what Luna calls Positif".
        const [a, b] = models;
        const cells = await query(
          `SELECT ${q(sentimentCols(a).polarity)} AS ra, ${q(sentimentCols(b).polarity)} AS rb, COUNT(*) AS c
           FROM ${viewName("articles")} ${whereSql} GROUP BY 1, 2`,
          params,
        );
        const counts: Record<string, Record<string, number>> = {};
        for (const r of cells) {
          const ka = r.ra == null || String(r.ra).trim() === "" ? "(unscored)" : String(r.ra);
          const kb = r.rb == null || String(r.rb).trim() === "" ? "(unscored)" : String(r.rb);
          counts[ka] ??= {};
          counts[ka][kb] = Number(r.c);
        }
        payload.agreement_matrix = { rows: a.id, cols: b.id, counts };
      }

      return structuredResult(payload);
    },
  );
}
