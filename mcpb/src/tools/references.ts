import { z } from "zod";
import { ensureView, getById, q, selectList } from "../db.js";
import {
  annotate,
  capLimit,
  capOffset,
  countryFilterIfExists,
  errorResult,
  foldedLike,
  likeFilterIfExists,
  pubDateOrder,
  referenceSummaryCols,
  runListQuery,
  textResult,
  yearRangeFilter,
  type Server,
} from "./_shared.js";

export function registerReferenceTools(server: Server): void {
  // === search_references ==================================================
  server.registerTool(
    "search_references",
    {
      description:
        "Search academic references (journal articles, book chapters, theses, books, reports) by keyword and metadata. " +
        "`keyword` is a single substring match over title + abstract, so search ONE term per call " +
        "(combined terms like 'pèlerinage Mecque' miss results); references are bilingual, so try French AND English terms. " +
        "Results include a short abstract snippet — use get_reference for the full abstract and bibliographic detail.",
      annotations: annotate("Search academic references"),
      inputSchema: {
        keyword: z.string().optional().describe("Substring match on title + abstract (one term per call, accent-insensitive)"),
        author: z.string().optional(),
        reference_type: z
          .string()
          .optional()
          .describe(
            "Substring match. Values: Article de revue | Chapitre de livre | Livre | Mémoire de maitrise | Rapport | " +
              "Thèse de doctorat | Communication scientifique | Compte rendu de livre | Article d'encyclopédie | " +
              "Mémoire de licence | Article de blog | Working paper. Use the full label for precision — " +
              "'Livre' alone also matches 'Chapitre de livre' and 'Compte rendu de livre'.",
          ),
        subject: z.string().optional().describe("Subject tag (sparse: ~27% of references are tagged)"),
        country: z
          .string()
          .optional()
          .describe("Exact country name: Benin | Burkina Faso | Côte d'Ivoire | Niger | Nigeria | Togo (accents optional)"),
        language: z.string().optional().describe("e.g. Français | Anglais"),
        date_from: z.string().optional().describe("Earliest year, YYYY"),
        date_to: z.string().optional().describe("Latest year, YYYY"),
        limit: z.number().int().optional().describe("Default 20, max 100"),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const schema = await ensureView("references");
      const limit = capLimit(args.limit, 20, 100);
      const offset = capOffset(args.offset);
      const where: string[] = [];
      const params: unknown[] = [];

      if (args.keyword) {
        const parts: string[] = [];
        const kw = `%${args.keyword}%`;
        for (const col of ["title", "abstract"]) {
          if (schema.has(col)) {
            parts.push(foldedLike(q(col)));
            params.push(kw);
          }
        }
        if (parts.length) where.push(`(${parts.join(" OR ")})`);
      }
      likeFilterIfExists(schema, where, params, "author", args.author);
      likeFilterIfExists(schema, where, params, "type", args.reference_type);
      likeFilterIfExists(schema, where, params, "subject", args.subject);
      countryFilterIfExists(schema, where, params, "country", args.country);
      likeFilterIfExists(schema, where, params, "language", args.language);
      yearRangeFilter(schema, where, params, args.date_from, args.date_to);

      return textResult(
        await runListQuery({
          subset: "references",
          where,
          params,
          cols: referenceSummaryCols(schema),
          orderBy: pubDateOrder(schema),
          limit,
          offset,
        }),
      );
    },
  );

  // === get_reference =======================================================
  server.registerTool(
    "get_reference",
    {
      description:
        "Full bibliographic record for one academic reference (by id), including the complete abstract " +
        "(present for ~51% of references), subjects, DOI/URL, and host-work details (book, volume, issue, pages).",
      annotations: annotate("Get reference details"),
      inputSchema: { reference_id: z.number().int() },
    },
    async ({ reference_id }) => {
      const schema = await ensureView("references");
      const cols = selectList(schema, [
        ['"o:id"', "id", ["o:id"]],
        "identifier",
        "title",
        "author",
        "editor",
        "type",
        ['"o:resource_class"', "resource_class", ["o:resource_class"]],
        ["pub_date", "date", ["pub_date"]],
        "publisher",
        "book_title",
        "chapter",
        "volume",
        "issue",
        "page_start",
        "page_end",
        "nb_pages",
        "edition",
        "extent",
        "abstract",
        "subject",
        "spatial",
        "language",
        "country",
        "doi",
        ['"URL"', "external_url", ["URL"]],
        "is_part_of",
        "review_of",
        "provenance",
        ["iwac_url", "url", ["iwac_url"]],
      ]);
      const row = await getById("references", cols, reference_id);
      if (!row) return errorResult({ error: `Reference ${reference_id} not found` });
      return textResult(row);
    },
  );
}
