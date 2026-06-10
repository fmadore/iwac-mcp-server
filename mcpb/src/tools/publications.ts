import { z } from "zod";
import { ensureView, getById, getManyByIds, q, query, selectList } from "../db.js";
import { semanticSearch } from "../embeddings.js";
import {
  annotate,
  capLimit,
  capOffset,
  capText,
  CHARACTER_LIMIT,
  countryFilterIfExists,
  errorResult,
  extractMatchingTocEntries,
  foldedLike,
  foldText,
  likeFilterIfExists,
  publicationSummaryCols,
  pubDateOrder,
  runListQuery,
  textResult,
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
        limit: z.number().int().optional().describe("Default 10, max 100"),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const schema = await ensureView("publications");
      const limit = capLimit(args.limit, 10, 100);
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
      countryFilterIfExists(schema, where, params, "country", args.country);
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
      if (!schema.has("newspaper")) return textResult({ total_periodicals: 0, periodicals: [] });
      const where: string[] = [`NULLIF(trim(newspaper), '') IS NOT NULL`];
      const params: unknown[] = [];
      countryFilterIfExists(schema, where, params, "country", args.country);
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
        country_filter: args.country ?? null,
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

      const contextChars = Math.max(200, Math.min(args.context_chars ?? 2000, 5000));
      const maxExcerpts = capLimit(args.max_excerpts, 10, 25);
      const half = Math.floor(contextChars / 2);
      // Accent/case-fold both sides (index-stable) so excerpt extraction agrees
      // with the accent-insensitive SQL search that found this publication.
      const haystack = foldText(ocr);
      const needle = foldText(args.keyword);

      // All match positions first (cheap), then excerpts up to the caps. A common
      // keyword in a 1M-char issue can match hundreds of times — uncapped, that
      // once produced a single ~150k-char (~38k-token) response.
      const positions: number[] = [];
      let pos = 0;
      while (true) {
        const idx = haystack.indexOf(needle, pos);
        if (idx === -1) break;
        positions.push(idx);
        pos = idx + Math.max(1, needle.length);
      }
      if (positions.length === 0) {
        result.excerpts = [];
        result.match_count = 0;
        result.note = `Keyword '${args.keyword}' not found in full text`;
        return textResult(result);
      }

      const excerpts: string[] = [];
      let coveredUntil = -1; // skip matches already visible in the previous excerpt
      let totalChars = 0;
      let capped = false;
      for (const idx of positions) {
        if (idx < coveredUntil) continue;
        if (excerpts.length >= maxExcerpts || totalChars >= CHARACTER_LIMIT) {
          capped = true;
          break;
        }
        const start = Math.max(0, idx - half);
        const end = Math.min(ocr.length, idx + needle.length + half);
        let ex = ocr.slice(start, end);
        if (start > 0) ex = "..." + ex;
        if (end < ocr.length) ex += "...";
        excerpts.push(ex);
        totalChars += ex.length;
        coveredUntil = end;
      }

      result.excerpts = excerpts;
      result.excerpts_returned = excerpts.length;
      result.match_count = positions.length;
      if (capped) {
        result.truncated = true;
        result.truncation_message =
          `Showing ${excerpts.length} excerpts for ${positions.length} matches. ` +
          `Use a more specific keyword, or raise max_excerpts (max 25) / page through with a narrower term.`;
      }
      return textResult(result);
    },
  );

  // === semantic_search_publications =======================================
  server.registerTool(
    "semantic_search_publications",
    {
      description:
        "Semantic similarity search over publication tables of contents using Gemini embeddings. " +
        "Note: TOC coverage is currently very sparse (few issues have a table of contents), so this returns " +
        "limited results until TOCs are enriched — prefer search_publications for keyword/OCR search. " +
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
      const limit = capLimit(args.limit, 10, 50);
      try {
        const hits = await semanticSearch({
          subset: "publications",
          embeddingColumn: "embedding_tableOfContents",
          query: args.query,
          overfetch: limit * 5,
        });
        const schema = await ensureView("publications");
        const cols = publicationSummaryCols(schema);
        const tocExpr = schema.has("tableOfContents") ? `, ${q("tableOfContents")}` : "";

        const extraWhere: string[] = [];
        const extraParams: unknown[] = [];
        countryFilterIfExists(schema, extraWhere, extraParams, "country", args.country);

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
          if (results.length >= limit) break;
        }
        return textResult({
          query: args.query,
          count: results.length,
          filters: { country: args.country ?? null },
          results,
        });
      } catch (err) {
        return errorResult({ error: String((err as Error).message ?? err) });
      }
    },
  );
}
