import { z } from "zod";
import { ensureView, getById, q, selectList } from "../db.js";
import {
  annotate,
  capOffset,
  capText,
  COUNTRIES,
  countryFilterIfExists,
  errorResult,
  foldedLike,
  keywordExcerpts,
  documentSummaryCols,
  pubDateOrder,
  resolveLimit,
  runListQuery,
  textResult,
  validateEnum,
  type Server,
} from "./_shared.js";

export function registerDocumentTools(server: Server): void {
  // === search_documents ====================================================
  server.registerTool(
    "search_documents",
    {
      description:
        "Search the small archival-documents subset (~26 items: Islamic association reports, flyers, project " +
        "documents — mostly Burkina Faso). All have OCR text and an AI description. Call with no arguments to list all.",
      annotations: annotate("Search archival documents"),
      inputSchema: {
        keyword: z.string().optional().describe("Substring match on title, OCR, AI description and subject (accent-insensitive)"),
        country: z
          .string()
          .optional()
          .describe("Exact country name: Benin | Burkina Faso | Côte d'Ivoire | Niger | Nigeria | Togo (accents optional; corpus is mostly Burkina Faso/Togo/Benin)"),
        limit: z.number().int().optional().describe("Default 15, max 50"),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const schema = await ensureView("documents");
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);
      const limit = resolveLimit(args.limit, 15, 50);
      const offset = capOffset(args.offset);
      const where: string[] = [];
      const params: unknown[] = [];

      if (args.keyword) {
        const parts: string[] = [];
        const kw = `%${args.keyword}%`;
        for (const col of ["title", "OCR", "descriptionAI", "subject"]) {
          if (schema.has(col)) {
            parts.push(foldedLike(q(col)));
            params.push(kw);
          }
        }
        if (parts.length) where.push(`(${parts.join(" OR ")})`);
      }
      countryFilterIfExists(schema, where, params, "country", country.canonical);

      return textResult(
        await runListQuery({
          subset: "documents",
          where,
          params,
          cols: documentSummaryCols(schema),
          orderBy: pubDateOrder(schema),
          limit,
          offset,
        }),
      );
    },
  );

  // === get_document ========================================================
  server.registerTool(
    "get_document",
    {
      description:
        "Get one archival document (by id): full metadata, AI description, and OCR text. " +
        "Pass a `keyword` to get ~2000-char excerpts around each match instead of the full (capped) OCR — " +
        "useful for long documents.",
      annotations: annotate("Get document details"),
      inputSchema: {
        document_id: z.number().int(),
        keyword: z
          .string()
          .optional()
          .describe("Return excerpts around matches instead of the full OCR (accent-insensitive)"),
        context_chars: z.number().int().optional().describe("Default 2000, max 5000"),
        max_excerpts: z.number().int().optional().describe("Default 10, max 25"),
      },
    },
    async ({ document_id, keyword, context_chars, max_excerpts }) => {
      const schema = await ensureView("documents");
      const cols = selectList(schema, [
        ['"o:id"', "id", ["o:id"]],
        "identifier",
        "title",
        "author",
        "country",
        ["pub_date", "date", ["pub_date"]],
        "type",
        "subject",
        "spatial",
        "language",
        "nb_pages",
        "source",
        "rights",
        ["iwac_url", "url", ["iwac_url"]],
        ['"descriptionAI"', "description_ai", ["descriptionAI"]],
        ["nb_mots", "word_count", ["nb_mots"]],
        ['"OCR"', "ocr_text", ["OCR"]],
      ]);
      const row = await getById("documents", cols, document_id);
      if (!row) return errorResult({ error: `Document ${document_id} not found` });
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
}
