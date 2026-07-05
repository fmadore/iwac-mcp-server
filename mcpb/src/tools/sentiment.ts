import { z } from "zod";
import { ensureView, query, queryScalarSingle, selectList, viewName } from "../db.js";
import {
  capOffset,
  CENTRALITY_VALUES,
  COUNTRIES,
  countryFilterIfExists,
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
  model: z.string(),
  total_articles: z.number(),
  filters: z.looseObject({}),
  polarity_distribution: z.record(z.string(), z.number()).optional(),
  centrality_distribution: z.record(z.string(), z.number()).optional(),
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
        country: z
          .string()
          .optional()
          .describe("Exact country name: Benin | Burkina Faso | Côte d'Ivoire | Niger | Togo (accents optional)"),
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
      const params: unknown[] = [];

      if (polarity.canonical && schema.has("gemini_polarite")) {
        where.push(foldedEquals("gemini_polarite"));
        params.push(polarity.canonical);
      }
      if (centrality.canonical && schema.has("gemini_centralite_islam_musulmans")) {
        where.push(foldedEquals("gemini_centralite_islam_musulmans"));
        params.push(centrality.canonical);
      }
      countryFilterIfExists(schema, where, params, "country", country.canonical);
      pipeValueFilterIfExists(schema, where, params, "subject", args.subject);

      const cols = selectList(schema, [
        ['"o:id"', "id", ["o:id"]],
        "title",
        "newspaper",
        "country",
        ["pub_date", "date", ["pub_date"]],
        ["gemini_polarite", "polarity", ["gemini_polarite"]],
        ["gemini_centralite_islam_musulmans", "centrality", ["gemini_centralite_islam_musulmans"]],
        ["gemini_subjectivite_score", "subjectivity", ["gemini_subjectivite_score"]],
        ["iwac_url", "url", ["iwac_url"]],
      ]);
      return textResult(
        await runListQuery({
          subset: "articles",
          where,
          params,
          cols,
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
      description: "Aggregate Gemini polarity and centrality counts across a filter set.",
      inputSchema: {
        country: z
          .string()
          .optional()
          .describe("Exact country name: Benin | Burkina Faso | Côte d'Ivoire | Niger | Togo (accents optional)"),
        newspaper: z.string().optional(),
        subject: z.string().optional(),
      },
      outputSchema: SENTIMENT_DISTRIBUTION_OUTPUT,
    },
    async (args) => {
      const schema = await ensureView("articles");
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);
      const where: string[] = [];
      const params: unknown[] = [];
      countryFilterIfExists(schema, where, params, "country", country.canonical);
      likeFilterIfExists(schema, where, params, "newspaper", args.newspaper);
      pipeValueFilterIfExists(schema, where, params, "subject", args.subject);
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      const total = Number(
        (await queryScalarSingle<number | bigint>(
          `SELECT COUNT(*) FROM ${viewName("articles")} ${whereSql}`,
          params,
        )) ?? 0,
      );
      const payload: Record<string, unknown> = {
        model: "gemini",
        total_articles: total,
        filters: {
          country: country.canonical ?? null,
          newspaper: args.newspaper ?? null,
          subject: args.subject ?? null,
        },
      };
      if (schema.has("gemini_polarite")) {
        const rows = await query(
          `SELECT gemini_polarite AS k, COUNT(*) AS c FROM ${viewName("articles")} ${whereSql} GROUP BY gemini_polarite`,
          params,
        );
        payload.polarity_distribution = rowsToMap(rows);
      }
      if (schema.has("gemini_centralite_islam_musulmans")) {
        const rows = await query(
          `SELECT gemini_centralite_islam_musulmans AS k, COUNT(*) AS c FROM ${viewName("articles")} ${whereSql} GROUP BY gemini_centralite_islam_musulmans`,
          params,
        );
        payload.centrality_distribution = rowsToMap(rows);
      }
      return structuredResult(payload);
    },
  );
}
