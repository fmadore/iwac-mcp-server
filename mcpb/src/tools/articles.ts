import { aggregateFilters, exactInput } from "./aggregates/shared.js";
import { z } from "zod";
import { ensureView, } from "../db.js";
import { config } from "../config.js";
import { requireSemanticFilters, runSemanticSearchTool } from "./_semantic.js";
import {
  capOffset,
  colsFor,
  COUNTRIES,
  countryParam,
  dateRangeFilter,
  detailResult,
  errorResult,
  likeFilterIfExists,
  pipeValueFilterIfExists,
  pubDateOrder,
  resolveLimit,
  runListQuery,
  textResult,
  toolMeta,
  validateDateBounds,
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
        "Search IWAC newspaper articles by keyword (title + OCR + AI abstracts, French and English), country, newspaper, subject, " +
        "and date range. Use French concept keywords regardless of the user's report language. Matching is accent- and case-insensitive.",
      inputSchema: z.object({
        ...exactInput(),
        keyword: z
          .string()
          .optional()
          .describe(
            "Concept keyword; substring match on title, OCR text, and the French and English AI abstracts. Prefer French for the OCR; an English term still matches via the English abstract",
          ),
        country: countryParam(),
        newspaper: z.string().optional(),
        subject: z.string().optional(),
        date_from: z.string().optional().describe("YYYY-MM-DD (or YYYY)"),
        date_to: z.string().optional().describe("YYYY-MM-DD (or YYYY)"),
        hijri_month: z
          .string()
          .optional()
          .describe(
            "Islamic lunar month: 1-12, or a name (Ramadan, Chaabane, Chawwal, Dhu al-Hijja). Pulls the articles " +
              "behind an observance peak — matches only items with a full YYYY-MM-DD date.",
          ),
        hijri_year: z.number().int().optional().describe("Islamic (Umm al-Qura) year, e.g. 1445"),
        with_description: z
          .boolean()
          .optional()
          .describe(
            "Include each article's ~500-char AI abstract (description_ai) for triage without get_article. Adds ~125 tokens/row, so `limit` defaults to 10 and caps at 25 while this is on.",
          ),
        limit: z.number().int().optional().describe("Default 20, max 100 (10 and 25 with with_description)"),
        offset: z.number().int().optional(),
      }),
    },
    async (args) => {
      const schema = await ensureView("articles");
      // Country, dates and the lunar pair are validated by aggregateFilters below.
      // `with_description` attaches a ~500-char AI abstract to every row, which
      // turns a 100-row page into ~27k tokens — past the 25k ceiling Claude Code
      // enforces on a tool result, so the whole answer is discarded rather than
      // trimmed. The tool description has always said "pass a smaller limit
      // (≤10)"; this makes the advice binding, and the clamp is reported through
      // the usual limit_warning rather than applied silently.
      const limit = args.with_description
        ? resolveLimit(
            args.limit,
            10,
            25,
            "`with_description` adds a ~500-char abstract per row; drop it to page 100 at a time.",
          )
        : resolveLimit(args.limit, 20, 100);
      const offset = capOffset(args.offset);
      const selection = aggregateFilters("articles", schema, args);
      if (selection.err) return errorResult(selection.err);
      const { where, params } = selection;

      return textResult(
        await runListQuery({
          subset: "articles",
          where,
          params,
          // `triage` = the summary row plus the AI abstract (with_description).
          cols: colsFor("articles", schema, args.with_description ? "triage" : "summary"),
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
        "Get one article (by id): full metadata, the AI abstract (description_ai), AI sentiment, and OCR text. " +
        "Pass a `keyword` to get ~2000-char excerpts around each match instead of the full (capped) OCR.",
      inputSchema: z.object({
        article_id: z.number().int(),
        keyword: z
          .string()
          .optional()
          .describe("Return excerpts around matches instead of the full OCR (accent-insensitive)"),
        context_chars: z.number().int().optional().describe("Default 2000, max 5000"),
        max_excerpts: z.number().int().optional().describe("Default 10, max 25"),
      }),
    },
    ({ article_id, keyword, context_chars, max_excerpts }) =>
      detailResult("articles", "Article", article_id, {
        key: "ocr_text",
        keyword,
        contextChars: context_chars,
        maxExcerpts: max_excerpts,
      }),
  );

  // Semantic search is dropped entirely when disabled (e.g. the public HTTP
  // endpoint); kept for the .mcpb / Claude Desktop build where a Google key is set.
  if (!config.semanticSearchEnabled) return;

  // === semantic_search_articles ===========================================
  server.registerTool(
    "semantic_search_articles",
    {
      ...toolMeta("Semantic search for articles", { openWorldHint: true }),
      description:
        "Semantic similarity search over article OCR using the configured embedding provider. The natural-language query may be in any language. Sends queries to the configured embedding provider; its model must match the stored corpus vectors.",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(8192).describe("Natural-language query, any language"),
        country: countryParam(),
        newspaper: z.string().optional(),
        date_from: z.string().optional().describe("YYYY-MM-DD (or YYYY)"),
        date_to: z.string().optional().describe("YYYY-MM-DD (or YYYY)"),
        limit: z.number().int().optional().describe("Default 10, max 50"),
      }),
    },
    async (args) => {
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);
      const dates = validateDateBounds(args.date_from, args.date_to);
      if (dates.err) return errorResult(dates.err);
      return runSemanticSearchTool({
        subset: "articles",
        embeddingColumn: "embedding_OCR",
        query: args.query,
        limit: resolveLimit(args.limit, 10, 50),
        summaryView: "summary",
        buildCandidateFilters: (schema, where, params) => {
          requireSemanticFilters(schema, { country: country.canonical, newspaper: args.newspaper, pub_date: args.date_from?.trim() || args.date_to?.trim() });
          pipeValueFilterIfExists(schema, where, params, "country", country.canonical);
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
