// Photographs (the `images` subset, added to the dataset in July 2026).
//
// Unlike every other subset this one has no OCR and almost no prose: the body
// column `description` is filled for 2 of 30 rows, so discovery runs on curated
// metadata (title, creator, subject, place) — which is also why matching it is
// cheap enough to sit in the unified search's fast pass. The payoff column is
// `embedding_image`: a MULTIMODAL vector of the photograph itself in the same
// 768-dim space as the text embeddings, so a French text query retrieves photos
// directly (semantic_search_images) without any caption to match against.
import { z } from "zod";
import { ensureView, getById, type Bindable } from "../db.js";
import { config } from "../config.js";
import { runSemanticSearchTool } from "./_semantic.js";
import {
  capOffset,
  colsFor,
  COUNTRIES,
  countryParam,
  dateRangeFilter,
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
  type Server,
} from "./_shared.js";

export function registerImageTools(server: Server): void {
  // === search_images =======================================================
  server.registerTool(
    "search_images",
    {
      ...toolMeta("Search photographs"),
      description:
        "Search the IWAC photographs (30 items: mosques, radio stations, schools, signage and street scenes " +
        "documented during fieldwork). Keyword matches title, creator, subject, place and the rare caption. " +
        "Each result carries `image_url` (the full-resolution file), `coordinates` ('lat, lng' where known) and " +
        "the canonical IWAC page. Call with no arguments to list all. Captions are almost never present, so " +
        "prefer subject/place filters over keywords, or semantic_search_images when it is enabled.",
      inputSchema: {
        keyword: z
          .string()
          .optional()
          .describe("French concept keyword; substring match on title, creator, subject, place and caption"),
        country: countryParam({ nigeria: true }),
        subject: z.string().optional().describe("Exact subject tag (pipe-aware)"),
        spatial: z.string().optional().describe("Exact place name, e.g. Ouagadougou (pipe-aware)"),
        creator: z.string().optional().describe("Photographer name (substring match)"),
        date_from: z.string().optional().describe("YYYY-MM-DD (or YYYY)"),
        date_to: z.string().optional().describe("YYYY-MM-DD (or YYYY)"),
        limit: z.number().int().optional().describe("Default 20, max 50"),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const schema = await ensureView("images");
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);
      const limit = resolveLimit(args.limit, 20, 50);
      const offset = capOffset(args.offset);
      const dates = validateDateBounds(args.date_from, args.date_to);
      if (dates.err) return errorResult(dates.err);
      const where: string[] = [];
      const params: Bindable[] = [];

      keywordFilter(schema, where, params, TEXT_COLS.images, args.keyword);
      pipeValueFilterIfExists(schema, where, params, "country", country.canonical);
      pipeValueFilterIfExists(schema, where, params, "subject", args.subject);
      pipeValueFilterIfExists(schema, where, params, "spatial", args.spatial);
      likeFilterIfExists(schema, where, params, "creator", args.creator);
      // Photographs carry day-precision capture dates, like articles.
      dateRangeFilter(schema, where, params, args.date_from, args.date_to);

      return textResult(
        await runListQuery({
          subset: "images",
          where,
          params,
          cols: colsFor("images", schema, "summary"),
          orderBy: pubDateOrder(schema),
          limit,
          offset,
        }),
      );
    },
  );

  // === get_image ===========================================================
  server.registerTool(
    "get_image",
    {
      ...toolMeta("Get photograph details"),
      description:
        "Get one photograph by id: title, photographer, capture date, place and coordinates, subjects, rights, " +
        "the IIIF manifest, and the full-resolution `image_url`. The server returns URLs, not image bytes.",
      inputSchema: { image_id: z.number().int() },
    },
    async ({ image_id }) => {
      const schema = await ensureView("images");
      const row = await getById("images", colsFor("images", schema, "detail"), image_id);
      if (!row) return errorResult({ error: `Image ${image_id} not found` });
      return textResult(row);
    },
  );

  // Semantic search is dropped entirely when disabled (e.g. the public HTTP
  // endpoint); kept for the .mcpb / Claude Desktop build where a Google key is set.
  if (!config.semanticSearchEnabled) return;

  // === semantic_search_images =============================================
  server.registerTool(
    "semantic_search_images",
    {
      ...toolMeta("Semantic search for photographs"),
      description:
        "Find photographs by describing what they SHOW, in any language ('mosquée en construction', 'street " +
        "signage in Arabic'). This is cross-modal: the ranking runs against a multimodal embedding of the " +
        "photograph itself, not against a caption, so it works even though only 2 of the 30 images have one. " +
        "Requires semantic search to be enabled and a Google API key.",
      inputSchema: {
        query: z.string().describe("Description of the visual content, any language"),
        country: countryParam({ nigeria: true }),
        limit: z.number().int().optional().describe("Default 10, max 30"),
      },
    },
    async (args) => {
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);
      return runSemanticSearchTool({
        subset: "images",
        embeddingColumn: "embedding_image",
        query: args.query,
        limit: resolveLimit(args.limit, 10, 30),
        summaryView: "summary",
        buildCandidateFilters: (schema, where, params) => {
          pipeValueFilterIfExists(schema, where, params, "country", country.canonical);
        },
        filtersEcho: { country: country.canonical ?? null },
      });
    },
  );
}
