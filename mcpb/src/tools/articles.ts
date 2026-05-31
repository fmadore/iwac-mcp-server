import { z } from "zod";
import { ensureView, getById, getManyByIds, q, selectList } from "../db.js";
import { semanticSearch } from "../embeddings.js";
import {
  annotate,
  articleSummaryCols,
  capLimit,
  capOffset,
  capText,
  likeFilterIfExists,
  pubDateOrder,
  runListQuery,
  textResult,
  type Server,
} from "./_shared.js";

export function registerArticleTools(server: Server): void {
  // === search_articles =====================================================
  server.registerTool(
    "search_articles",
    {
      description:
        "Search IWAC newspaper articles by keyword (title+OCR), country, newspaper, subject, and date range.",
      annotations: annotate("Search newspaper articles"),
      inputSchema: {
        keyword: z.string().optional().describe("Full-text search in title and OCR"),
        country: z.string().optional(),
        newspaper: z.string().optional(),
        subject: z.string().optional(),
        date_from: z.string().optional().describe("YYYY-MM-DD"),
        date_to: z.string().optional().describe("YYYY-MM-DD"),
        limit: z.number().int().optional().describe("Default 20, max 100"),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const schema = await ensureView("articles");
      const limit = capLimit(args.limit, 20, 100);
      const offset = capOffset(args.offset);
      const where: string[] = [];
      const params: unknown[] = [];

      likeFilterIfExists(schema, where, params, "country", args.country);
      likeFilterIfExists(schema, where, params, "newspaper", args.newspaper);
      likeFilterIfExists(schema, where, params, "subject", args.subject);

      if (args.keyword) {
        const parts: string[] = [];
        if (schema.has("title")) {
          parts.push("title ILIKE ?");
          params.push(`%${args.keyword}%`);
        }
        if (schema.has("OCR")) {
          parts.push(`${q("OCR")} ILIKE ?`);
          params.push(`%${args.keyword}%`);
        }
        if (parts.length) where.push(`(${parts.join(" OR ")})`);
      }
      if (args.date_from && schema.has("pub_date")) {
        where.push("pub_date >= CAST(? AS TIMESTAMPTZ)");
        params.push(args.date_from);
      }
      if (args.date_to && schema.has("pub_date")) {
        where.push("pub_date <= CAST(? AS TIMESTAMPTZ)");
        params.push(args.date_to);
      }

      return textResult(
        await runListQuery({
          subset: "articles",
          where,
          params,
          cols: articleSummaryCols(schema),
          orderBy: pubDateOrder(schema),
          limit,
          offset,
        }),
      );
    },
  );

  // === get_article =========================================================
  server.registerTool(
    "get_article",
    {
      description: "Get full metadata and OCR text for an article (by o:id).",
      annotations: annotate("Get article details"),
      inputSchema: {
        article_id: z.number().int(),
      },
    },
    async ({ article_id }) => {
      const schema = await ensureView("articles");
      const cols = selectList(schema, [
        ['"o:id"', "id", ["o:id"]],
        "identifier",
        "title",
        "author",
        "newspaper",
        "country",
        "pub_date",
        "subject",
        "spatial",
        "language",
        "nb_pages",
        ["iwac_url", "url", ["iwac_url"]],
        ['"OCR"', "ocr_text", ["OCR"]],
        ["nb_mots", "word_count", ["nb_mots"]],
        ['"Richesse_Lexicale_OCR"', "lexical_richness", ["Richesse_Lexicale_OCR"]],
        ['"Lisibilite_OCR"', "readability", ["Lisibilite_OCR"]],
        ["gemini_centralite_islam_musulmans", "gemini_centrality", ["gemini_centralite_islam_musulmans"]],
        ["gemini_polarite", "gemini_polarity", ["gemini_polarite"]],
        ["gemini_subjectivite_score", "gemini_subjectivity", ["gemini_subjectivite_score"]],
      ]);
      const row = await getById("articles", cols, article_id);
      if (!row) return textResult({ error: `Article ${article_id} not found` });
      if (typeof row.ocr_text === "string") {
        const capped = capText(row.ocr_text);
        row.ocr_text = capped.text;
        if (capped.truncated) {
          row.truncated = true;
          row.truncation_message = capped.truncation_message;
        }
      }
      return textResult(row);
    },
  );

  // === semantic_search_articles ===========================================
  server.registerTool(
    "semantic_search_articles",
    {
      description:
        "Semantic similarity search over article OCR using Gemini embeddings. Requires semantic search to be enabled and a Google API key.",
      annotations: annotate("Semantic search for articles"),
      inputSchema: {
        query: z.string(),
        country: z.string().optional(),
        newspaper: z.string().optional(),
        date_from: z.string().optional(),
        date_to: z.string().optional(),
        limit: z.number().int().optional().describe("Default 10, max 50"),
      },
    },
    async (args) => {
      const limit = capLimit(args.limit, 10, 50);
      try {
        const hits = await semanticSearch({
          subset: "articles",
          embeddingColumn: "embedding_OCR",
          query: args.query,
          overfetch: limit * 5,
        });
        const schema = await ensureView("articles");
        const cols = articleSummaryCols(schema);

        // Push the metadata filters into SQL and fetch every candidate in one query.
        const extraWhere: string[] = [];
        const extraParams: unknown[] = [];
        likeFilterIfExists(schema, extraWhere, extraParams, "country", args.country);
        likeFilterIfExists(schema, extraWhere, extraParams, "newspaper", args.newspaper);
        if (args.date_from && schema.has("pub_date")) {
          extraWhere.push("pub_date >= CAST(? AS TIMESTAMPTZ)");
          extraParams.push(args.date_from);
        }
        if (args.date_to && schema.has("pub_date")) {
          extraWhere.push("pub_date <= CAST(? AS TIMESTAMPTZ)");
          extraParams.push(args.date_to);
        }

        const rows = await getManyByIds(
          "articles",
          cols,
          hits.map((h) => h.id),
          extraWhere,
          extraParams,
        );
        const byId = new Map(rows.map((r) => [String(r["o:id"]), r]));

        // Walk hits in similarity order, keeping those that survived the filters.
        const results: Record<string, unknown>[] = [];
        for (const h of hits) {
          const row = byId.get(h.id);
          if (!row) continue;
          results.push({ ...row, similarity_score: Number(h.score.toFixed(4)) });
          if (results.length >= limit) break;
        }
        return textResult({
          query: args.query,
          count: results.length,
          filters: {
            country: args.country ?? null,
            newspaper: args.newspaper ?? null,
            date_from: args.date_from ?? null,
            date_to: args.date_to ?? null,
          },
          results,
        });
      } catch (err) {
        return textResult({ error: String((err as Error).message ?? err) });
      }
    },
  );
}
