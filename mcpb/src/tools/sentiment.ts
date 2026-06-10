import { z } from "zod";
import { ensureView, query, queryScalarSingle, selectList } from "../db.js";
import {
  annotate,
  capLimit,
  capOffset,
  countryFilterIfExists,
  foldedEquals,
  likeFilterIfExists,
  pubDateOrder,
  rowsToMap,
  runListQuery,
  textResult,
  type Server,
} from "./_shared.js";

export function registerSentimentTools(server: Server): void {
  // === search_by_sentiment =================================================
  server.registerTool(
    "search_by_sentiment",
    {
      description:
        "Filter articles by Gemini sentiment labels (accent/case-insensitive exact match).",
      annotations: annotate("Filter articles by AI sentiment"),
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
        limit: z.number().int().optional().describe("Default 10, max 100"),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const schema = await ensureView("articles");
      const limit = capLimit(args.limit, 10, 100);
      const offset = capOffset(args.offset);
      const where: string[] = [];
      const params: unknown[] = [];

      if (args.polarity && schema.has("gemini_polarite")) {
        where.push(foldedEquals("gemini_polarite"));
        params.push(args.polarity);
      }
      if (args.centrality && schema.has("gemini_centralite_islam_musulmans")) {
        where.push(foldedEquals("gemini_centralite_islam_musulmans"));
        params.push(args.centrality);
      }
      countryFilterIfExists(schema, where, params, "country", args.country);
      likeFilterIfExists(schema, where, params, "subject", args.subject);

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
      description: "Aggregate Gemini polarity and centrality counts across a filter set.",
      annotations: annotate("Aggregate AI sentiment"),
      inputSchema: {
        country: z
          .string()
          .optional()
          .describe("Exact country name: Benin | Burkina Faso | Côte d'Ivoire | Niger | Togo (accents optional)"),
        newspaper: z.string().optional(),
        subject: z.string().optional(),
      },
    },
    async (args) => {
      const schema = await ensureView("articles");
      const where: string[] = [];
      const params: unknown[] = [];
      countryFilterIfExists(schema, where, params, "country", args.country);
      likeFilterIfExists(schema, where, params, "newspaper", args.newspaper);
      likeFilterIfExists(schema, where, params, "subject", args.subject);
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      const total = Number(
        (await queryScalarSingle<number | bigint>(
          `SELECT COUNT(*) FROM articles ${whereSql}`,
          params,
        )) ?? 0,
      );
      const payload: Record<string, unknown> = {
        model: "gemini",
        total_articles: total,
        filters: {
          country: args.country ?? null,
          newspaper: args.newspaper ?? null,
          subject: args.subject ?? null,
        },
      };
      if (schema.has("gemini_polarite")) {
        const rows = await query(
          `SELECT gemini_polarite AS k, COUNT(*) AS c FROM articles ${whereSql} GROUP BY gemini_polarite`,
          params,
        );
        payload.polarity_distribution = rowsToMap(rows);
      }
      if (schema.has("gemini_centralite_islam_musulmans")) {
        const rows = await query(
          `SELECT gemini_centralite_islam_musulmans AS k, COUNT(*) AS c FROM articles ${whereSql} GROUP BY gemini_centralite_islam_musulmans`,
          params,
        );
        payload.centrality_distribution = rowsToMap(rows);
      }
      return textResult(payload);
    },
  );
}
