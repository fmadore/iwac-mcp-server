import { z } from "zod";
import { ensureView, q, query, queryOne, queryScalarSingle, viewName, type Bindable } from "../db.js";
import { SENTIMENT_MODELS } from "./aggregates.js";
import { CHARTS_UI_META, VIEW } from "./appUi.js";
import {
  capOffset,
  CENTRALITY_VALUES,
  COUNTRIES,
  colsFor,
  countryParam,
  errorResult,
  foldedEquals,
  likeFilterIfExists,
  pipeValueFilterIfExists,
  POLARITY_VALUES,
  pubDateOrder,
  resolveLimit,
  rowsToMap,
  runListQuery,
  structuredResult,
  textResult,
  toolMeta,
  validateEnum,
  type Server,
} from "./_shared.js";

// Small, stable envelope → worth a structured-output contract. Distributions
// are optional because the sentiment columns may be absent from a revision.
const SENTIMENT_DISTRIBUTION_OUTPUT = {
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
};

export function registerSentimentTools(server: Server): void {
  // === search_by_sentiment =================================================
  server.registerTool(
    "search_by_sentiment",
    {
      ...toolMeta("Filter articles by AI sentiment"),
      description:
        "Filter articles by Gemini sentiment labels (accent/case-insensitive exact match).",
      inputSchema: {
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
      },
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
      const where: string[] = [];
      const params: Bindable[] = [];

      if (polarity.canonical && schema.has("gemini_polarite")) {
        where.push(foldedEquals("gemini_polarite"));
        params.push(polarity.canonical);
      }
      if (centrality.canonical && schema.has("gemini_centralite_islam_musulmans")) {
        where.push(foldedEquals("gemini_centralite_islam_musulmans"));
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
        "Aggregate AI polarity, centrality and subjectivity across a filter set. Three models scored every " +
        'article independently — gemini (default), chatgpt and mistral — so model:"all" returns each one\'s ' +
        "distribution plus how often they AGREE. Treat disagreement as a fact about the judgement rather than " +
        "noise: in a set where the three models split on polarity, no single model's number should be quoted " +
        "alone. Scores cover every article whether or not its full text ships, so these shares are not subject " +
        "to the OCR coverage limit.",
      _meta: CHARTS_UI_META,
      inputSchema: {
        country: countryParam(),
        newspaper: z.string().optional(),
        subject: z.string().optional(),
        model: z
          .string()
          .optional()
          .describe('gemini (default) | chatgpt | mistral | all — "all" adds the cross-model agreement'),
      },
      outputSchema: SENTIMENT_DISTRIBUTION_OUTPUT,
    },
    async (args) => {
      const schema = await ensureView("articles");
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);
      const modelV = validateEnum(args.model, [...SENTIMENT_MODELS, "all"] as const, "model");
      if (modelV.err) return errorResult(modelV.err);
      const requested = modelV.canonical ?? "gemini";
      const where: string[] = [];
      const params: Bindable[] = [];
      pipeValueFilterIfExists(schema, where, params, "country", country.canonical);
      likeFilterIfExists(schema, where, params, "newspaper", args.newspaper);
      pipeValueFilterIfExists(schema, where, params, "subject", args.subject);
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      // Only the models this revision actually carries. Asking for a missing
      // one is an error naming the real list, not a silent all-zero envelope.
      const available = SENTIMENT_MODELS.filter((m) => schema.has(`${m}_polarite`));
      if (!available.length) {
        return errorResult({ error: "This dataset revision carries no AI sentiment columns" });
      }
      if (requested !== "all" && !available.includes(requested as (typeof SENTIMENT_MODELS)[number])) {
        return errorResult({ error: `Model '${requested}' is not in this dataset revision`, valid_values: available });
      }
      const models = requested === "all" ? [...available] : [requested as (typeof SENTIMENT_MODELS)[number]];

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
      const distributionsFor = async (model: string): Promise<Record<string, unknown>> => {
        const out: Record<string, unknown> = {};
        if (schema.has(`${model}_polarite`)) {
          out.polarity_distribution = rowsToMap(
            await query(
              `SELECT ${q(`${model}_polarite`)} AS k, COUNT(*) AS c FROM ${viewName("articles")} ${whereSql} GROUP BY 1`,
              params,
            ),
          );
        }
        if (schema.has(`${model}_centralite_islam_musulmans`)) {
          out.centrality_distribution = rowsToMap(
            await query(
              `SELECT ${q(`${model}_centralite_islam_musulmans`)} AS k, COUNT(*) AS c FROM ${viewName("articles")} ${whereSql} GROUP BY 1`,
              params,
            ),
          );
        }
        // Subjectivity is an INTEGER 1-5 rating, not a 0-1 proportion, so the
        // scale ships with the numbers: a bare mean of 2.12 reads as "21%
        // subjective" to anyone who assumes the usual normalised score. The
        // per-level counts come along because five buckets cost almost nothing
        // and say more than any average of an ordinal rating.
        if (schema.has(`${model}_subjectivite_score`)) {
          const col = q(`${model}_subjectivite_score`);
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

      if (requested !== "all") {
        Object.assign(payload, await distributionsFor(requested));
        return structuredResult(payload);
      }

      const byModel: Record<string, unknown> = {};
      for (const m of models) byModel[m] = await distributionsFor(m);
      payload.models = models;
      payload.by_model = byModel;

      if (models.length > 1) {
        // Agreement is measured on polarity: the field most likely to differ
        // between models and the one whose number gets quoted the most.
        const cols = models.map((m) => q(`${m}_polarite`));
        const scoredExpr = cols.map((c) => `NULLIF(trim(${c}), '') IS NOT NULL`).join(" AND ");
        const sameExpr = cols.slice(1).map((c) => `${cols[0]} = ${c}`).join(" AND ");
        const pairExprs = models.flatMap((a, i) =>
          models.slice(i + 1).map((b) => ({
            key: `${a}~${b}`,
            sql: `COUNT(*) FILTER (WHERE ${q(`${a}_polarite`)} = ${q(`${b}_polarite`)} AND ${scoredExpr})`,
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
        // useful than "chatgpt reads as Neutre what gemini calls Négatif".
        const [a, b] = models;
        const cells = await query(
          `SELECT ${q(`${a}_polarite`)} AS ra, ${q(`${b}_polarite`)} AS rb, COUNT(*) AS c
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
        payload.agreement_matrix = { rows: a, cols: b, counts };
      }

      return structuredResult(payload);
    },
  );
}
