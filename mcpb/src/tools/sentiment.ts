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
  SENTIMENT_MODEL_IDS,
  SENTIMENT_MODELS,
  sentimentCols,
  structuredResult,
  textResult,
  toolMeta,
  validateEnum,
  type SentimentModel,
  type Server,
} from "./_shared.js";

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
        "disagree; get_sentiment_distribution with model:\"all\" shows by how much.",
      inputSchema: z.object({
        polarity: z
          .string()
          .optional()
          .describe("Très positif | Positif | Neutre | Négatif | Très négatif | Non applicable"),
        centrality: z
          .string()
          .optional()
          .describe("Très central | Central | Secondaire | Marginal | Non abordé"),
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
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);
      const limit = resolveLimit(args.limit, 20, 100);
      const offset = capOffset(args.offset);
      const cols = sentimentCols(DEFAULT_SENTIMENT_MODEL);
      const where: string[] = [];
      const params: Bindable[] = [];

      // A requested filter whose column this revision lacks is an error, not a
      // dropped clause: silently returning the unfiltered corpus reads as "every
      // article is Très négatif". Reachable on a cache predating the 2026-07-31
      // sentiment column rename.
      if (polarity.canonical) {
        if (!schema.has(cols.polarity)) {
          return errorResult({ error: `This dataset revision has no ${cols.polarity} column, so polarity cannot be filtered` });
        }
        where.push(foldedEquals(cols.polarity));
        params.push(polarity.canonical);
      }
      if (centrality.canonical) {
        if (!schema.has(cols.centrality)) {
          return errorResult({ error: `This dataset revision has no ${cols.centrality} column, so centrality cannot be filtered` });
        }
        where.push(foldedEquals(cols.centrality));
        params.push(centrality.canonical);
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
        "alone. Articles were scored whether or not their full text ships, so these shares are not subject to " +
        "the OCR coverage limit; compare scored_by_all against total_articles for the residual gap.",
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
              '"all" adds the cross-model agreement. The vendor shorthands gemini/chatgpt/mistral are ' +
              "also accepted and resolve to the model that ran.",
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
        return errorResult({ error: `Invalid model: ${raw}`, valid_values: [...SENTIMENT_MODEL_IDS, "all"] });
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
        // Subjectivity is an INTEGER 1-5 rating, not a 0-1 proportion, so the
        // scale ships with the numbers: a bare mean of 2.12 reads as "21%
        // subjective" to anyone who assumes the usual normalised score. The
        // per-level counts come along because five buckets cost almost nothing
        // and say more than any average of an ordinal rating.
        if (schema.has(cols.subjectivity)) {
          const col = q(cols.subjectivity);
          const row = await queryOne(
            `SELECT ROUND(AVG(${col}), 3) AS mean, ROUND(median(${col}), 3) AS med, COUNT(${col}) AS scored
             FROM ${viewName("articles")} ${whereSql}`,
            params,
          );
          if (row?.mean != null) {
            out.subjectivity = {
              scale: "1-5 (1 = most factual, 5 = most opinionated)",
              mean: Number(row.mean),
              median: Number(row.med),
              scored: Number(row.scored),
              distribution: rowsToMap(
                await query(
                  `SELECT CAST(${col} AS VARCHAR) AS k, COUNT(*) AS c FROM ${viewName("articles")} ${whereSql} GROUP BY 1`,
                  params,
                ),
              ),
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
        // useful than "gpt-5-mini reads as Neutre what gemini calls Négatif".
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
