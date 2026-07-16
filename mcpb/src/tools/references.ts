import { z } from "zod";
import { ensureView, getById, type Bindable } from "../db.js";
import {
  capOffset,
  COUNTRIES,
  countryFilterIfExists,
  countryParam,
  detailColsFor,
  errorResult,
  keywordFilter,
  likeFilterIfExists,
  pipeValueFilterIfExists,
  pubDateOrder,
  referenceSummaryCols,
  resolveLimit,
  runListQuery,
  TEXT_COLS,
  textResult,
  toolMeta,
  validateEnum,
  yearRangeFilter,
  type Server,
} from "./_shared.js";

export function registerReferenceTools(server: Server): void {
  // === search_references ==================================================
  server.registerTool(
    "search_references",
    {
      ...toolMeta("Search academic references"),
      description:
        "Search academic references (journal articles, book chapters, theses, books, reports) by keyword and metadata. " +
        "`keyword` is a single substring match over title + abstract, so search ONE term per call " +
        "(combined terms like 'pèlerinage Mecque' miss results). References are multilingual: try French and English title/abstract keywords when relevant; metadata/filter values such as `reference_type` and `language` use French labels. " +
        "Results include a short abstract snippet — use get_reference for the full abstract and bibliographic detail.",
      inputSchema: {
        keyword: z.string().optional().describe("One French or English concept keyword; substring match on title + abstract (one term per call, accent-insensitive)"),
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
        country: countryParam({ nigeria: true }),
        language: z.string().optional().describe("e.g. Français | Anglais"),
        date_from: z.string().optional().describe("Earliest year, YYYY"),
        date_to: z.string().optional().describe("Latest year, YYYY"),
        limit: z.number().int().optional().describe("Default 20, max 100"),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const schema = await ensureView("references");
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);
      const limit = resolveLimit(args.limit, 20, 100);
      const offset = capOffset(args.offset);
      const where: string[] = [];
      const params: Bindable[] = [];

      keywordFilter(schema, where, params, TEXT_COLS.references, args.keyword);
      likeFilterIfExists(schema, where, params, "author", args.author);
      likeFilterIfExists(schema, where, params, "type", args.reference_type);
      pipeValueFilterIfExists(schema, where, params, "subject", args.subject);
      countryFilterIfExists(schema, where, params, "country", country.canonical);
      pipeValueFilterIfExists(schema, where, params, "language", args.language);
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
      ...toolMeta("Get reference details"),
      description:
        "Full bibliographic record for one academic reference (by id), including the complete abstract " +
        "(present for ~51% of references), subjects, DOI/URL, and host-work details (book, volume, issue, pages).",
      inputSchema: { reference_id: z.number().int() },
    },
    async ({ reference_id }) => {
      const schema = await ensureView("references");
      const row = await getById("references", detailColsFor("references", schema, "get"), reference_id);
      if (!row) return errorResult({ error: `Reference ${reference_id} not found` });
      return textResult(row);
    },
  );
}
