import { z } from "zod";
import { ensureView, getById, q, selectList, type Bindable } from "../db.js";
import {
  capOffset,
  COUNTRIES,
  countryFilterIfExists,
  countryParam,
  detailColsFor,
  errorResult,
  foldedEquals,
  keywordFilter,
  MEDIUM_VALUES,
  pipeValueFilterIfExists,
  pubDateOrder,
  resolveLimit,
  runListQuery,
  TEXT_COLS,
  textResult,
  toolMeta,
  validateEnum,
  type Server,
} from "./_shared.js";

function audiovisualSummaryCols(schema: Set<string>): string {
  return selectList(schema, [
    ['"o:id"', "id", ["o:id"]],
    "title",
    "creator",
    "publisher",
    "country",
    ["pub_date", "date", ["pub_date"]],
    "medium",
    "extent",
    "subject",
    "spatial",
    "language",
    ["PDF", "media_url", ["PDF"]],
    ["iwac_url", "url", ["iwac_url"]],
  ]);
}

export function registerAudiovisualTools(server: Server): void {
  // === search_audiovisual ==================================================
  server.registerTool(
    "search_audiovisual",
    {
      ...toolMeta("Search audiovisual materials"),
      description:
        "Search audiovisual materials by keyword and metadata. Keyword matches title, creator, publisher, subject, spatial, language, source, and AI description where present.",
      inputSchema: {
        keyword: z.string().optional().describe("Substring match across audiovisual title/metadata fields"),
        country: countryParam({ nigeria: true, note: "The subset is currently all Nigeria" }),
        language: z.string().optional().describe("Exact language value, e.g. Haoussa | Arabe | Anglais"),
        medium: z.string().optional().describe("Exact medium: audio | video (validated)"),
        subject: z.string().optional().describe("Exact subject tag"),
        limit: z.number().int().optional().describe("Default 20, max 50"),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const schema = await ensureView("audiovisual");
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);
      // medium is a closed vocabulary — validate it like country/polarity so a
      // typo returns {error, valid_values} instead of a silent zero.
      const medium = validateEnum(args.medium, MEDIUM_VALUES, "medium");
      if (medium.err) return errorResult(medium.err);
      const limit = resolveLimit(args.limit, 20, 50);
      const offset = capOffset(args.offset);
      const where: string[] = [];
      const params: Bindable[] = [];

      keywordFilter(schema, where, params, TEXT_COLS.audiovisual, args.keyword);
      countryFilterIfExists(schema, where, params, "country", country.canonical);
      pipeValueFilterIfExists(schema, where, params, "language", args.language);
      pipeValueFilterIfExists(schema, where, params, "subject", args.subject);
      if (medium.canonical && schema.has("medium")) {
        where.push(foldedEquals(q("medium")));
        params.push(medium.canonical);
      }

      return textResult(
        await runListQuery({
          subset: "audiovisual",
          where,
          params,
          cols: audiovisualSummaryCols(schema),
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
        "List audiovisual materials (currently 45 Nigerian recordings, incl. Hausa/Arabic content).",
      inputSchema: {
        country: countryParam({ nigeria: true, note: "The subset is currently all Nigeria" }),
        limit: z.number().int().optional().describe("Default 20, max 50"),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const schema = await ensureView("audiovisual");
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);
      const limit = resolveLimit(args.limit, 20, 50);
      const offset = capOffset(args.offset);
      const where: string[] = [];
      const params: Bindable[] = [];
      countryFilterIfExists(schema, where, params, "country", country.canonical);

      return textResult(
        await runListQuery({
          subset: "audiovisual",
          where,
          params,
          cols: audiovisualSummaryCols(schema),
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
        "Get one audiovisual record by id, including creator/publisher, media URL, duration, medium, subjects, places, language, source, and IWAC URL.",
      inputSchema: { audiovisual_id: z.number().int() },
    },
    async ({ audiovisual_id }) => {
      const schema = await ensureView("audiovisual");
      const row = await getById("audiovisual", detailColsFor("audiovisual", schema, "get"), audiovisual_id);
      if (!row) return errorResult({ error: `Audiovisual item ${audiovisual_id} not found` });
      return textResult(row);
    },
  );
}
