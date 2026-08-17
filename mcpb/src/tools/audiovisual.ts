import { z } from "zod";
import { ensureView, getById, q, type Bindable } from "../db.js";
import {
  capOffset,
  COUNTRIES,
  colsFor,
  countryParam,
  errorResult,
  foldedEquals,
  keywordFilter,
  likeFilterIfExists,
  MEDIUM_VALUES,
  pipeValueFilterIfExists,
  pubDateOrder,
  resolveLimit,
  runListQuery,
  SOURCE_TYPE_VALUES,
  TEXT_COLS,
  textResult,
  toolMeta,
  validateEnum,
  type Server,
} from "./_shared.js";

export function registerAudiovisualTools(server: Server): void {
  // === search_audiovisual ==================================================
  server.registerTool(
    "search_audiovisual",
    {
      ...toolMeta("Search audiovisual materials"),
      description:
        "Search audiovisual materials by keyword and metadata: francophone web video from Burkina Faso, Togo and Benin (TV reports, association and campus recordings), plus deposited Nigerian Hausa/Arabic recordings. Keyword matches title, creator, publisher, subject, spatial, language, source, the item's own description (the richest text most of these items have) and its transcription where one exists. Each row says which population it is from (`source_type`) and carries either `external_url` (a video to watch) or `media_url` (a file), never both.",
      inputSchema: z.object({
        keyword: z.string().optional().describe("Substring match across audiovisual title/metadata fields"),
        country: countryParam({ nigeria: true, note: "Burkina Faso, Togo, Benin and Nigeria only — no Niger or Ivorian items" }),
        language: z.string().optional().describe("Exact language value, e.g. Français | Haoussa | Arabe | Anglais | Mooré"),
        medium: z.string().optional().describe("Exact carrier medium: Vidéo sur le web | DVD | CD (validated, accents optional)"),
        // The channel/broadcaster facet. Substring, not exact: the stored values
        // are full institutional names ("RTB - Radiodiffusion Télévision du
        // Burkina"), and a caller asking for RTB should not have to type that.
        publisher: z
          .string()
          .optional()
          .describe("Substring on the publishing channel/broadcaster, e.g. RTB | AEEM | CERFI"),
        // No row counts here: the YouTube harvest is still running, so any
        // number written into a tool description is stale within the week.
        source_type: z
          .string()
          .optional()
          .describe("youtube (harvested web video, the large majority) | deposited (recordings with a file, 47)"),
        subject: z.string().optional().describe("Exact subject tag — only ~27 rows carry one, so prefer publisher/keyword"),
        limit: z.number().int().optional().describe("Default 20, max 50"),
        offset: z.number().int().optional(),
      }),
    },
    async (args) => {
      const schema = await ensureView("audiovisual");
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);
      // medium is a closed vocabulary — validate it like country/polarity so a
      // typo returns {error, valid_values} instead of a silent zero.
      const medium = validateEnum(args.medium, MEDIUM_VALUES, "medium");
      if (medium.err) return errorResult(medium.err);
      const sourceType = validateEnum(args.source_type, SOURCE_TYPE_VALUES, "source_type");
      if (sourceType.err) return errorResult(sourceType.err);
      const limit = resolveLimit(args.limit, 20, 50);
      const offset = capOffset(args.offset);
      const where: string[] = [];
      const params: Bindable[] = [];

      keywordFilter(schema, where, params, TEXT_COLS.audiovisual, args.keyword);
      pipeValueFilterIfExists(schema, where, params, "country", country.canonical);
      pipeValueFilterIfExists(schema, where, params, "language", args.language);
      pipeValueFilterIfExists(schema, where, params, "subject", args.subject);
      likeFilterIfExists(schema, where, params, "publisher", args.publisher);
      if (medium.canonical && schema.has("medium")) {
        where.push(foldedEquals(q("medium")));
        params.push(medium.canonical);
      }
      if (sourceType.canonical && schema.has("source_type")) {
        where.push(foldedEquals(q("source_type")));
        params.push(sourceType.canonical);
      }

      return textResult(
        await runListQuery({
          subset: "audiovisual",
          where,
          params,
          cols: colsFor("audiovisual", schema, "summary"),
          orderBy: pubDateOrder(schema),
          limit,
          offset,
        }),
      );
    },
  );

  // === list_audiovisual ====================================================
  server.registerTool(
    "list_audiovisual",
    {
      ...toolMeta("List audiovisual materials"),
      description:
        "List audiovisual materials, newest first (francophone web video from Burkina Faso, Togo and Benin; deposited Nigerian Hausa/Arabic recordings). Filter by country, publishing channel or `source_type`.",
      inputSchema: z.object({
        country: countryParam({ nigeria: true, note: "Burkina Faso, Togo, Benin and Nigeria only — no Niger or Ivorian items" }),
        publisher: z
          .string()
          .optional()
          .describe("Substring on the publishing channel/broadcaster, e.g. RTB | AEEM | CERFI"),
        // No row counts here: the YouTube harvest is still running, so any
        // number written into a tool description is stale within the week.
        source_type: z
          .string()
          .optional()
          .describe("youtube (harvested web video, the large majority) | deposited (recordings with a file, 47)"),
        limit: z.number().int().optional().describe("Default 20, max 50"),
        offset: z.number().int().optional(),
      }),
    },
    async (args) => {
      const schema = await ensureView("audiovisual");
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);
      const sourceType = validateEnum(args.source_type, SOURCE_TYPE_VALUES, "source_type");
      if (sourceType.err) return errorResult(sourceType.err);
      const limit = resolveLimit(args.limit, 20, 50);
      const offset = capOffset(args.offset);
      const where: string[] = [];
      const params: Bindable[] = [];
      pipeValueFilterIfExists(schema, where, params, "country", country.canonical);
      likeFilterIfExists(schema, where, params, "publisher", args.publisher);
      if (sourceType.canonical && schema.has("source_type")) {
        where.push(foldedEquals(q("source_type")));
        params.push(sourceType.canonical);
      }

      return textResult(
        await runListQuery({
          subset: "audiovisual",
          where,
          params,
          cols: colsFor("audiovisual", schema, "summary"),
          orderBy: pubDateOrder(schema),
          limit,
          offset,
        }),
      );
    },
  );

  // === get_audiovisual =====================================================
  server.registerTool(
    "get_audiovisual",
    {
      ...toolMeta("Get audiovisual details"),
      description:
        "Get one audiovisual record by id: full description and transcription (where one exists), creator/publishing channel, duration, medium, subjects, places, language, rights, source, and three distinct links — `url` (the IWAC page, the one to cite), `external_url` (where a harvested video plays) and `media_url` (a deposited file). `source_type` says which to expect.",
      inputSchema: z.object({ audiovisual_id: z.number().int() }),
    },
    async ({ audiovisual_id }) => {
      const schema = await ensureView("audiovisual");
      const row = await getById("audiovisual", colsFor("audiovisual", schema, "detail"), audiovisual_id);
      if (!row) return errorResult({ error: `Audiovisual item ${audiovisual_id} not found` });
      return textResult(row);
    },
  );
}
