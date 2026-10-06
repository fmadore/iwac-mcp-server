import { z } from "zod";
import { ensureView, type Bindable } from "../db.js";
import {
  capOffset,
  colsFor,
  COUNTRIES,
  countryParam,
  detailResult,
  errorResult,
  keywordFilter,
  pipeValueFilterIfExists,
  pubDateOrder,
  resolveLimit,
  runListQuery,
  TEXT_COLS,
  textOffsetParam,
  textResult,
  toolMeta,
  validateEnum,
  type Server,
} from "./_shared.js";

export function registerDocumentTools(server: Server): void {
  // === search_documents ====================================================
  server.registerTool(
    "search_documents",
    {
      ...toolMeta("Search archival documents"),
      description:
        "Search the small archival-documents subset (~26 items: Islamic association reports, flyers, project " +
        "documents — mostly Burkina Faso). Use French concept keywords regardless of the user's report language. Most have OCR text and an AI description. Call with no arguments to list all.",
      inputSchema: z.object({
        keyword: z.string().optional().describe("Concept keyword; substring match on title, OCR, the French and English AI descriptions, and subject (accent-insensitive)"),
        country: countryParam({ nigeria: true, note: "Corpus is mostly Burkina Faso/Togo/Benin" }),
        limit: z.number().int().optional().describe("Default 15, max 50"),
        offset: z.number().int().optional(),
      }),
    },
    async (args) => {
      const schema = await ensureView("documents");
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);
      const limit = resolveLimit(args.limit, 15, 50);
      const offset = capOffset(args.offset);
      const where: string[] = [];
      const params: Bindable[] = [];

      keywordFilter(schema, where, params, TEXT_COLS.documents, args.keyword);
      pipeValueFilterIfExists(schema, where, params, "country", country.canonical);

      return textResult(
        await runListQuery({
          subset: "documents",
          where,
          params,
          cols: colsFor("documents", schema, "summary"),
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
      ...toolMeta("Get document details"),
      description:
        "Get one archival document (by id): full metadata, AI description, and OCR text, in 25k-char parts " +
        "(follow `next_offset`). Pass a `keyword` to get ~2000-char excerpts around each match instead, " +
        "useful for long documents.",
      inputSchema: z.object({
        document_id: z.number().int(),
        keyword: z
          .string()
          .optional()
          .describe("Return excerpts around matches instead of the full OCR (accent-insensitive)"),
        context_chars: z.number().int().optional().describe("Default 2000, max 5000"),
        max_excerpts: z.number().int().optional().describe("Default 10, max 25"),
        offset: textOffsetParam(),
      }),
    },
    ({ document_id, keyword, context_chars, max_excerpts, offset }) =>
      detailResult("documents", "Document", document_id, {
        key: "ocr_text",
        keyword,
        contextChars: context_chars,
        maxExcerpts: max_excerpts,
        offset,
      }),
  );
}
