import { z } from "zod";
import { ensureView, getById, getManyByIds, q, query, selectList } from "../db.js";
import { semanticSearch } from "../embeddings.js";
import { config } from "../config.js";
import {
  annotate,
  capOffset,
  capText,
  COUNTRIES,
  countryFilterIfExists,
  errorResult,
  extractMatchingTocEntries,
  foldedLike,
  keywordExcerpts,
  likeFilterIfExists,
  publicationSummaryCols,
  pubDateOrder,
  resolveLimit,
  runListQuery,
  textResult,
  validateEnum,
  yearRangeFilter,
  type Server,
} from "./_shared.js";

export function registerPublicationTools(server: Server): void {
  // === search_publications ================================================
  server.registerTool(
    "search_publications",
    {
      description:
        "Search Islamic publications (periodical issues, books). `keyword` matches title, subject and full OCR text; " +
        "filter by newspaper/series, subject, country and year. Use list_periodicals to discover series titles, and " +
        "get_publication_fulltext for keyword excerpts from a single issue.",
      annotations: annotate("Search publications"),
      inputSchema: {
        keyword: z.string().optional().describe("Substring match on title + subject + OCR (accent-insensitive)"),
        newspaper: z.string().optional().describe("Periodical/series title (see list_periodicals)"),
        subject: z.string().optional().describe("Subject tag (~87% of issues are tagged)"),
        country: z
          .string()
          .optional()
          .describe("Exact country name: Benin | Burkina Faso | Côte d'Ivoire | Niger | Togo (accents optional)"),
        date_from: z.string().optional().describe("Earliest year, YYYY"),
        date_to: z.string().optional().describe("Latest year, YYYY"),
        limit: z.number().int().optional().describe("Default 20, max 100"),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const schema = await ensureView("publications");
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);
      const limit = resolveLimit(args.limit, 20, 100);
      const offset = capOffset(args.offset);

      const where: string[] = [];
      const params: unknown[] = [];
      if (args.keyword) {
        const parts: string[] = [];
        const kw = `%${args.keyword}%`;
        for (const col of ["title", "subject", "tableOfContents", "OCR"]) {
          if (schema.has(col)) {
            parts.push(foldedLike(q(col)));
            params.push(kw);
          }
        }
        if (parts.length) where.push(`(${parts.join(" OR ")})`);
      }
      likeFilterIfExists(schema, where, params, "newspaper", args.newspaper);
      likeFilterIfExists(schema, where, params, "subject", args.subject);
      countryFilterIfExists(schema, where, params, "country", country.canonical);
      yearRangeFilter(schema, where, params, args.date_from, args.date_to);

      const cols = publicationSummaryCols(schema);
      const tocExpr =
        args.keyword && schema.has("tableOfContents") ? `, ${q("tableOfContents")}` : "";

      const env = await runListQuery<Record<string, unknown>>({
        subset: "publications",
        where,
        params,
        cols: `${cols}${tocExpr}`,
        orderBy: pubDateOrder(schema),
        limit,
        offset,
      });
      if (args.keyword) {
        for (const r of env.results) {
          const toc = r.tableOfContents ? String(r.tableOfContents) : "";
          const matching = extractMatchingTocEntries(toc, args.keyword);
          delete r.tableOfContents;
          if (matching) r.matching_toc_entries = matching;
        }
      }
      return textResult(env);
    },
  );

  // === list_periodicals ===================================================
  server.registerTool(
    "list_periodicals",
    {
      description:
        "List the Islamic periodical/series titles in the publications subset, with issue counts and year ranges. " +
        "Use the returned newspaper value as the `newspaper` filter on search_publications.",
      annotations: annotate("List periodicals"),
      inputSchema: {
        country: z
          .string()
          .optional()
          .describe("Exact country name: Benin | Burkina Faso | Côte d'Ivoire | Niger | Togo (accents optional)"),
      },
    },
    async (args) => {
      const schema = await ensureView("publications");
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);
      if (!schema.has("newspaper")) return textResult({ total_periodicals: 0, periodicals: [] });
      const where: string[] = [`NULLIF(trim(newspaper), '') IS NOT NULL`];
      const params: unknown[] = [];
      countryFilterIfExists(schema, where, params, "country", country.canonical);
      const dateCols = schema.has("pub_date")
        ? `, MIN(TRY_CAST(substr("pub_date", 1, 4) AS INTEGER)) AS earliest_year,` +
          ` MAX(TRY_CAST(substr("pub_date", 1, 4) AS INTEGER)) AS latest_year`
        : "";
      const whereSql = `WHERE ${where.join(" AND ")}`;
      const rows = await query(
        `SELECT newspaper, country, COUNT(*) AS issue_count${dateCols}
         FROM publications ${whereSql}
         GROUP BY newspaper, country
         ORDER BY issue_count DESC`,
        params,
      );
      return textResult({
        country_filter: country.canonical ?? null,
        total_periodicals: rows.length,
        periodicals: rows,
      });
    },
  );

  // === get_publication_fulltext ===========================================
  server.registerTool(
    "get_publication_fulltext",
    {
      description:
        "Full OCR text of a publication, optionally returning ~2000-char excerpts around keyword matches " +
        "(accent-insensitive; capped — see match_count vs excerpts_returned).",
      annotations: annotate("Get publication full text"),
      inputSchema: {
        publication_id: z.number().int(),
        keyword: z.string().optional(),
        context_chars: z.number().int().optional().describe("Default 2000, max 5000"),
        max_excerpts: z.number().int().optional().describe("Default 10, max 25"),
      },
    },
    async (args) => {
      const schema = await ensureView("publications");
      const cols = selectList(schema, [
        ['"o:id"', "id", ["o:id"]],
        "title",
        "tableOfContents",
        ['"OCR"', "fulltext", ["OCR"]],
      ]);
      const row = await getById("publications", cols, args.publication_id);
      if (!row) return errorResult({ error: `Publication ${args.publication_id} not found` });

      const result: Record<string, unknown> = {
        id: args.publication_id,
        title: row.title ?? "",
      };
      if (row.tableOfContents) result.tableOfContents = row.tableOfContents;

      const ocr = (row.fulltext as string | null) ?? "";
      if (!ocr.trim()) {
        result.fulltext = null;
        result.note = "No OCR text available for this publication";
        return textResult(result);
      }
      if (!args.keyword) {
        // Whole-issue OCR can exceed a million characters — cap it and point at
        // the keyword path.
        const capped = capText(ocr, { suggestKeyword: true });
        result.fulltext = capped.text;
        result.char_count = ocr.length;
        if (capped.truncated) {
          result.truncated = true;
          result.truncation_message = capped.truncation_message;
        }
        return textResult(result);
      }

      Object.assign(
        result,
        keywordExcerpts(ocr, args.keyword, {
          contextChars: args.context_chars,
          maxExcerpts: args.max_excerpts,
        }),
      );
      return textResult(result);
    },
  );

  // Semantic search is dropped entirely when disabled (e.g. the public HTTP
  // endpoint); kept for the .mcpb / Claude Desktop build where a Google key is set.
  if (!config.semanticSearchEnabled) return;

  // === semantic_search_publications =======================================
  server.registerTool(
    "semantic_search_publications",
    {
      description:
        "Semantic similarity search over publication tables of contents using Gemini embeddings. " +
        "TOC coverage: ~22% of issues — complete for 17 of the 25 series (the smaller magazines), but absent " +
        "for the three largest (Islam Info, An-Nasr Vendredi, Islam Hebdo); use search_publications for those. " +
        "Requires semantic search to be enabled and a Google API key.",
      annotations: annotate("Semantic search for publications"),
      inputSchema: {
        query: z.string(),
        country: z
          .string()
          .optional()
          .describe("Exact country name: Benin | Burkina Faso | Côte d'Ivoire | Niger | Togo (accents optional)"),
        limit: z.number().int().optional().describe("Default 10, max 50"),
      },
    },
    async (args) => {
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);
      const limit = resolveLimit(args.limit, 10, 50);
      try {
        const hits = await semanticSearch({
          subset: "publications",
          embeddingColumn: "embedding_tableOfContents",
          query: args.query,
          overfetch: limit.value * 5,
        });
        const schema = await ensureView("publications");
        const cols = publicationSummaryCols(schema);
        const tocExpr = schema.has("tableOfContents") ? `, ${q("tableOfContents")}` : "";

        const extraWhere: string[] = [];
        const extraParams: unknown[] = [];
        countryFilterIfExists(schema, extraWhere, extraParams, "country", country.canonical);

        const rows = await getManyByIds(
          "publications",
          `${cols}${tocExpr}`,
          hits.map((h) => h.id),
          extraWhere,
          extraParams,
        );
        const byId = new Map(rows.map((r) => [String(r.id), r]));

        const results: Record<string, unknown>[] = [];
        for (const h of hits) {
          const row = byId.get(h.id);
          if (!row) continue;
          const out: Record<string, unknown> = {
            ...row,
            similarity_score: Number(h.score.toFixed(4)),
          };
          if (!row.tableOfContents) delete out.tableOfContents;
          results.push(out);
          if (results.length >= limit.value) break;
        }
        return textResult({
          query: args.query,
          count: results.length,
          limit: limit.value,
          ...(limit.capped ? { requested_limit: limit.requested } : {}),
          filters: { country: country.canonical ?? null },
          results,
        });
      } catch (err) {
        return errorResult({ error: String((err as Error).message ?? err) });
      }
    },
  );
}
