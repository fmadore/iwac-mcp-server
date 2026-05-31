import { z } from "zod";
import { ensureView, query, queryScalarSingle, selectList } from "../db.js";
import {
  annotate,
  capLimit,
  capOffset,
  likeFilterIfExists,
  normaliseSentiment,
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
        "Filter articles by Gemini sentiment (polarity: Très positif..Très négatif; centrality: Très central..Non abordé).",
      annotations: annotate("Filter articles by AI sentiment"),
      inputSchema: {
        polarity: z.string().optional(),
        centrality: z.string().optional(),
        country: z.string().optional(),
        subject: z.string().optional(),
        limit: z.number().int().optional(),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const schema = await ensureView("articles");
      const limit = capLimit(args.limit, 20, 100);
      const offset = capOffset(args.offset);
      const where: string[] = [];
      const params: unknown[] = [];

      const polarity = normaliseSentiment(args.polarity);
      const centrality = normaliseSentiment(args.centrality);
      if (polarity && schema.has("gemini_polarite")) {
        where.push("gemini_polarite = ?");
        params.push(polarity);
      }
      if (centrality && schema.has("gemini_centralite_islam_musulmans")) {
        where.push("gemini_centralite_islam_musulmans = ?");
        params.push(centrality);
      }
      likeFilterIfExists(schema, where, params, "country", args.country);
      likeFilterIfExists(schema, where, params, "subject", args.subject);

      const cols = selectList(schema, [
        ['"o:id"', "o:id", ["o:id"]],
        "title",
        "newspaper",
        "country",
        "pub_date",
        "gemini_polarite",
        "gemini_centralite_islam_musulmans",
        "gemini_subjectivite_score",
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
        country: z.string().optional(),
        newspaper: z.string().optional(),
        subject: z.string().optional(),
      },
    },
    async (args) => {
      const schema = await ensureView("articles");
      const where: string[] = [];
      const params: unknown[] = [];
      likeFilterIfExists(schema, where, params, "country", args.country);
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
