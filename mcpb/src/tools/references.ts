import { z } from "zod";
import { config } from "../config.js";
import { ensureView, type Bindable } from "../db.js";
import { EMBEDDING_COLUMNS } from "../embeddingContract.js";
import { requireSemanticFilters, runSemanticSearchTool, SEMANTIC_NOTE } from "./_semantic.js";
import {
  capOffset,
  colsFor,
  COUNTRIES,
  countryParam,
  detailResult,
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
  validateDateBounds,
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
      inputSchema: z.object({
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
      }),
    },
    async (args) => {
      const schema = await ensureView("references");
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);
      const limit = resolveLimit(args.limit, 20, 100);
      const offset = capOffset(args.offset);
      const dates = validateDateBounds(args.date_from, args.date_to);
      if (dates.err) return errorResult(dates.err);
      const where: string[] = [];
      const params: Bindable[] = [];

      keywordFilter(schema, where, params, TEXT_COLS.references, args.keyword);
      likeFilterIfExists(schema, where, params, "author", args.author);
      likeFilterIfExists(schema, where, params, "type", args.reference_type);
      pipeValueFilterIfExists(schema, where, params, "subject", args.subject);
      pipeValueFilterIfExists(schema, where, params, "country", country.canonical);
      pipeValueFilterIfExists(schema, where, params, "language", args.language);
      yearRangeFilter(schema, where, params, args.date_from, args.date_to);

      return textResult(
        await runListQuery({
          subset: "references",
          where,
          params,
          cols: colsFor("references", schema, "summary"),
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
      inputSchema: z.object({ reference_id: z.number().int() }),
    },
    ({ reference_id }) => detailResult("references", "Reference", reference_id),
  );

  // Semantic search is dropped entirely when IWAC_SEMANTIC_SEARCH_ENABLED is off.
  if (!config.semanticSearchEnabled) return;

  // === semantic_search_references =========================================
  server.registerTool(
    "semantic_search_references",
    {
      ...toolMeta("Semantic search for academic references"),
      description:
        "Semantic search over academic references by title + abstract, across languages. Only references with an " +
        `abstract (about half) are covered; use search_references for the rest. ${SEMANTIC_NOTE}`,
      inputSchema: z.object({
        query: z.string().trim().min(1).max(8192).describe("Natural-language query, any language"),
        reference_type: z.string().optional().describe("French type label, substring (e.g. Thèse de doctorat)"),
        country: countryParam({ nigeria: true }),
        language: z.string().optional().describe("e.g. Français | Anglais"),
        date_from: z.string().optional().describe("Earliest year, YYYY"),
        date_to: z.string().optional().describe("Latest year, YYYY"),
        limit: z.number().int().optional().describe("Default 10, max 50"),
      }),
    },
    async (args) => {
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);
      const dates = validateDateBounds(args.date_from, args.date_to);
      if (dates.err) return errorResult(dates.err);
      return runSemanticSearchTool({
        subset: "references",
        embeddingColumn: EMBEDDING_COLUMNS.references,
        query: args.query,
        limit: resolveLimit(args.limit, 10, 50),
        summaryView: "summary",
        buildCandidateFilters: (schema, where, params) => {
          requireSemanticFilters(schema, {
            type: args.reference_type,
            country: country.canonical,
            language: args.language,
            pub_date: args.date_from?.trim() || args.date_to?.trim(),
          });
          likeFilterIfExists(schema, where, params, "type", args.reference_type);
          pipeValueFilterIfExists(schema, where, params, "country", country.canonical);
          pipeValueFilterIfExists(schema, where, params, "language", args.language);
          yearRangeFilter(schema, where, params, args.date_from, args.date_to);
        },
        filtersEcho: {
          reference_type: args.reference_type ?? null,
          country: country.canonical ?? null,
          language: args.language ?? null,
          date_from: args.date_from ?? null,
          date_to: args.date_to ?? null,
        },
      });
    },
  );
}
