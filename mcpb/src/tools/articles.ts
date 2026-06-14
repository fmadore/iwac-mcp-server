import { z } from "zod";
import { ensureView, getById, getManyByIds, q, selectList } from "../db.js";
import { semanticSearch } from "../embeddings.js";
import {
  annotate,
  articleSummaryCols,
  capLimit,
  capOffset,
  capText,
  countryFilterIfExists,
  dateRangeFilter,
  errorResult,
  foldedLike,
  keywordExcerpts,
  likeFilterIfExists,
  pubDateOrder,
  runListQuery,
  textResult,
  type Server,
} from "./_shared.js";

/** keyword OR-clause over title + OCR + AI abstract, accent/case-insensitive. */
function articleKeywordFilter(
  schema: Set<string>,
  where: string[],
  params: unknown[],
  keyword: string | undefined,
): void {
  if (!keyword) return;
  const parts: string[] = [];
  for (const col of ["title", "OCR", "descriptionAI"]) {
    if (schema.has(col)) {
      parts.push(foldedLike(q(col)));
      params.push(`%${keyword}%`);
    }
  }
  if (parts.length) where.push(`(${parts.join(" OR ")})`);
}

export function registerArticleTools(server: Server): void {
  // === search_articles =====================================================
  server.registerTool(
    "search_articles",
    {
      description:
        "Search IWAC newspaper articles by keyword (title + OCR + AI abstract), country, newspaper, subject, " +
        "and date range. Matching is accent- and case-insensitive.",
      annotations: annotate("Search newspaper articles"),
      inputSchema: {
        keyword: z.string().optional().describe("Substring match on title, OCR text, and AI abstract"),
        country: z
          .string()
          .optional()
          .describe("Exact country name: Benin | Burkina Faso | Côte d'Ivoire | Niger | Togo (accents optional)"),
        newspaper: z.string().optional(),
        subject: z.string().optional(),
        date_from: z.string().optional().describe("YYYY-MM-DD (or YYYY)"),
        date_to: z.string().optional().describe("YYYY-MM-DD (or YYYY)"),
        with_description: z
          .boolean()
          .optional()
          .describe("Include each article's ~500-char AI abstract (description_ai) for triage without get_article. Adds ~125 tokens/row, so pass a smaller limit (≤10) when enabling it."),
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

      countryFilterIfExists(schema, where, params, "country", args.country);
      likeFilterIfExists(schema, where, params, "newspaper", args.newspaper);
      likeFilterIfExists(schema, where, params, "subject", args.subject);
      articleKeywordFilter(schema, where, params, args.keyword);
      dateRangeFilter(schema, where, params, args.date_from, args.date_to);

      let cols = articleSummaryCols(schema);
      if (args.with_description && schema.has("descriptionAI")) {
        cols += `, ${q("descriptionAI")} AS description_ai`;
      }
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

  // === get_article =========================================================
  server.registerTool(
    "get_article",
    {
      description:
        "Get one article (by id): full metadata, the AI abstract (description_ai), Gemini sentiment, and OCR text. " +
        "Pass a `keyword` to get ~2000-char excerpts around each match instead of the full (capped) OCR.",
      annotations: annotate("Get article details"),
      inputSchema: {
        article_id: z.number().int(),
        keyword: z
          .string()
          .optional()
          .describe("Return excerpts around matches instead of the full OCR (accent-insensitive)"),
        context_chars: z.number().int().optional().describe("Default 2000, max 5000"),
        max_excerpts: z.number().int().optional().describe("Default 10, max 25"),
      },
    },
    async ({ article_id, keyword, context_chars, max_excerpts }) => {
      const schema = await ensureView("articles");
      const cols = selectList(schema, [
        ['"o:id"', "id", ["o:id"]],
        "identifier",
        "title",
        "author",
        "newspaper",
        "country",
        ["pub_date", "date", ["pub_date"]],
        "subject",
        "spatial",
        "language",
        "nb_pages",
        ["iwac_url", "url", ["iwac_url"]],
        ['"descriptionAI"', "description_ai", ["descriptionAI"]],
        ["gemini_polarite", "polarity", ["gemini_polarite"]],
        ["gemini_centralite_islam_musulmans", "centrality", ["gemini_centralite_islam_musulmans"]],
        ["gemini_subjectivite_score", "subjectivity", ["gemini_subjectivite_score"]],
        ["nb_mots", "word_count", ["nb_mots"]],
        ['"Richesse_Lexicale_OCR"', "lexical_richness", ["Richesse_Lexicale_OCR"]],
        ['"Lisibilite_OCR"', "readability", ["Lisibilite_OCR"]],
        ['"OCR"', "ocr_text", ["OCR"]],
      ]);
      const row = await getById("articles", cols, article_id);
      if (!row) return errorResult({ error: `Article ${article_id} not found` });
      const ocr = typeof row.ocr_text === "string" ? row.ocr_text : "";
      if (keyword && ocr.trim()) {
        delete row.ocr_text;
        Object.assign(row, keywordExcerpts(ocr, keyword, { contextChars: context_chars, maxExcerpts: max_excerpts }));
      } else if (ocr) {
        const capped = capText(ocr, { suggestKeyword: true });
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
        country: z
          .string()
          .optional()
          .describe("Exact country name: Benin | Burkina Faso | Côte d'Ivoire | Niger | Togo (accents optional)"),
        newspaper: z.string().optional(),
        date_from: z.string().optional().describe("YYYY-MM-DD (or YYYY)"),
        date_to: z.string().optional().describe("YYYY-MM-DD (or YYYY)"),
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
        countryFilterIfExists(schema, extraWhere, extraParams, "country", args.country);
        likeFilterIfExists(schema, extraWhere, extraParams, "newspaper", args.newspaper);
        dateRangeFilter(schema, extraWhere, extraParams, args.date_from, args.date_to);

        const rows = await getManyByIds(
          "articles",
          cols,
          hits.map((h) => h.id),
          extraWhere,
          extraParams,
        );
        const byId = new Map(rows.map((r) => [String(r.id), r]));

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
        return errorResult({ error: String((err as Error).message ?? err) });
      }
    },
  );
}
