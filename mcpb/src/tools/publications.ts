import { z } from "zod";
import { ensureView, getById, getManyByIds, q, selectList } from "../db.js";
import { semanticSearch } from "../embeddings.js";
import {
  annotate,
  capLimit,
  capOffset,
  capText,
  errorResult,
  extractMatchingTocEntries,
  likeFilterIfExists,
  publicationSummaryCols,
  pubDateOrder,
  runListQuery,
  textResult,
  type Server,
} from "./_shared.js";

export function registerPublicationTools(server: Server): void {
  // === search_publications ================================================
  server.registerTool(
    "search_publications",
    {
      description:
        "Search Islamic publications (books, periodicals). When the keyword matches the table of contents, only matching TOC entries are returned.",
      annotations: annotate("Search publications"),
      inputSchema: {
        keyword: z.string().optional(),
        country: z.string().optional(),
        limit: z.number().int().optional(),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const schema = await ensureView("publications");
      const limit = capLimit(args.limit, 20, 100);
      const offset = capOffset(args.offset);

      const where: string[] = [];
      const params: unknown[] = [];
      if (args.keyword) {
        const parts: string[] = [];
        const kw = `%${args.keyword}%`;
        if (schema.has("title")) {
          parts.push("title ILIKE ?");
          params.push(kw);
        }
        if (schema.has("descriptionAI")) {
          parts.push(`${q("descriptionAI")} ILIKE ?`);
          params.push(kw);
        }
        if (schema.has("tableOfContents")) {
          parts.push(`${q("tableOfContents")} ILIKE ?`);
          params.push(kw);
        }
        if (parts.length) where.push(`(${parts.join(" OR ")})`);
      }
      likeFilterIfExists(schema, where, params, "country", args.country);

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

  // === get_publication_fulltext ===========================================
  server.registerTool(
    "get_publication_fulltext",
    {
      description:
        "Full OCR text of a publication, optionally returning ~2000-char excerpts around each keyword match.",
      annotations: annotate("Get publication full text"),
      inputSchema: {
        publication_id: z.number().int(),
        keyword: z.string().optional(),
        context_chars: z.number().int().optional().describe("Default 2000, max 5000"),
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
        "o:id": args.publication_id,
        title: row.title ?? "",
      };
      if (row.tableOfContents) result.tableOfContents = row.tableOfContents;

      const ocr = (row.fulltext as string | null) ?? "";
      if (!ocr) {
        result.fulltext = null;
        result.note = "No OCR text available for this publication";
        return textResult(result);
      }
      if (!args.keyword) {
        // Whole-book OCR can be enormous — cap it and point at the keyword path.
        const capped = capText(ocr, { suggestKeyword: true });
        result.fulltext = capped.text;
        result.char_count = ocr.length;
        if (capped.truncated) {
          result.truncated = true;
          result.truncation_message = capped.truncation_message;
        }
        return textResult(result);
      }
      const contextChars = Math.min(args.context_chars ?? 2000, 5000);
      const half = Math.floor(contextChars / 2);
      const lower = ocr.toLowerCase();
      const kw = args.keyword.toLowerCase();
      const excerpts: string[] = [];
      let pos = 0;
      while (true) {
        const idx = lower.indexOf(kw, pos);
        if (idx === -1) break;
        const start = Math.max(0, idx - half);
        const end = Math.min(ocr.length, idx + args.keyword.length + half);
        let ex = ocr.slice(start, end);
        if (start > 0) ex = "..." + ex;
        if (end < ocr.length) ex += "...";
        excerpts.push(ex);
        pos = idx + args.keyword.length;
      }
      if (excerpts.length === 0) {
        result.excerpts = [];
        result.note = `Keyword '${args.keyword}' not found in full text`;
      } else {
        result.excerpts = excerpts;
        result.match_count = excerpts.length;
      }
      return textResult(result);
    },
  );

  // === semantic_search_publications =======================================
  server.registerTool(
    "semantic_search_publications",
    {
      description:
        "Semantic similarity search over publication tables of contents using Gemini embeddings. Requires semantic search to be enabled and a Google API key.",
      annotations: annotate("Semantic search for publications"),
      inputSchema: {
        query: z.string(),
        country: z.string().optional(),
        limit: z.number().int().optional(),
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
        likeFilterIfExists(schema, extraWhere, extraParams, "country", args.country);

        const rows = await getManyByIds(
          "publications",
          `${cols}${tocExpr}`,
          hits.map((h) => h.id),
          extraWhere,
          extraParams,
        );
        const byId = new Map(rows.map((r) => [String(r["o:id"]), r]));

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
