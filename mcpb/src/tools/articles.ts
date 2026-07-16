import { z } from "zod";
import { ensureView, getById, q, type Bindable } from "../db.js";
import { config } from "../config.js";
import { runSemanticSearchTool } from "./_semantic.js";
import {
  articleSummaryCols,
  attachOcrOrExcerpts,
  capOffset,
  COUNTRIES,
  countryFilterIfExists,
  countryParam,
  dateRangeFilter,
  detailColsFor,
  errorResult,
  keywordFilter,
  likeFilterIfExists,
  pipeValueFilterIfExists,
  pubDateOrder,
  resolveLimit,
  runListQuery,
  TEXT_COLS,
  textResult,
  toolMeta,
  validateEnum,
  type Server,
} from "./_shared.js";

export function registerArticleTools(server: Server): void {
  // === search_articles =====================================================
  server.registerTool(
    "search_articles",
    {
      ...toolMeta("Search newspaper articles"),
      description:
        "Search IWAC newspaper articles by keyword (title + OCR + AI abstract), country, newspaper, subject, " +
        "and date range. Use French concept keywords regardless of the user's report language. Matching is accent- and case-insensitive.",
      inputSchema: {
        keyword: z.string().optional().describe("French concept keyword; substring match on title, OCR text, and AI abstract"),
        country: countryParam(),
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
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);
      const limit = resolveLimit(args.limit, 20, 100);
      const offset = capOffset(args.offset);
      const where: string[] = [];
      const params: Bindable[] = [];

      countryFilterIfExists(schema, where, params, "country", country.canonical);
      likeFilterIfExists(schema, where, params, "newspaper", args.newspaper);
      pipeValueFilterIfExists(schema, where, params, "subject", args.subject);
      keywordFilter(schema, where, params, TEXT_COLS.articles, args.keyword);
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
      ...toolMeta("Get article details"),
      description:
        "Get one article (by id): full metadata, the AI abstract (description_ai), Gemini sentiment, and OCR text. " +
        "Pass a `keyword` to get ~2000-char excerpts around each match instead of the full (capped) OCR.",
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
      const row = await getById("articles", detailColsFor("articles", schema, "get"), article_id);
      if (!row) return errorResult({ error: `Article ${article_id} not found` });
      attachOcrOrExcerpts(row, "ocr_text", keyword, { contextChars: context_chars, maxExcerpts: max_excerpts });
      return textResult(row);
    },
  );

  // Semantic search is dropped entirely when disabled (e.g. the public HTTP
  // endpoint); kept for the .mcpb / Claude Desktop build where a Google key is set.
  if (!config.semanticSearchEnabled) return;

  // === semantic_search_articles ===========================================
  server.registerTool(
    "semantic_search_articles",
    {
      ...toolMeta("Semantic search for articles"),
      description:
        "Semantic similarity search over article OCR using Gemini embeddings. The natural-language query may be in any language. Requires semantic search to be enabled and a Google API key.",
      inputSchema: {
        query: z.string().describe("Natural-language query, any language"),
        country: countryParam(),
        newspaper: z.string().optional(),
        date_from: z.string().optional().describe("YYYY-MM-DD (or YYYY)"),
        date_to: z.string().optional().describe("YYYY-MM-DD (or YYYY)"),
        limit: z.number().int().optional().describe("Default 10, max 50"),
      },
    },
    async (args) => {
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);
      return runSemanticSearchTool({
        subset: "articles",
        embeddingColumn: "embedding_OCR",
        query: args.query,
        limit: resolveLimit(args.limit, 10, 50),
        summaryCols: articleSummaryCols,
        buildCandidateFilters: (schema, where, params) => {
          countryFilterIfExists(schema, where, params, "country", country.canonical);
          likeFilterIfExists(schema, where, params, "newspaper", args.newspaper);
          dateRangeFilter(schema, where, params, args.date_from, args.date_to);
        },
        filtersEcho: {
          country: country.canonical ?? null,
          newspaper: args.newspaper ?? null,
          date_from: args.date_from ?? null,
          date_to: args.date_to ?? null,
        },
      });
    },
  );
}
