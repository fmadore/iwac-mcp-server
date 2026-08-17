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

export function registerAudiovisualTools(server: Server): void {
  // === search_audiovisual ==================================================
  server.registerTool(
    "search_audiovisual",
    {
      ...toolMeta("Search audiovisual materials"),
      description:
        "Search audiovisual materials by keyword and metadata: francophone web video from Burkina Faso, Togo and Benin (TV reports, association and campus recordings), plus deposited Nigerian Hausa/Arabic recordings. Keyword matches title, creator, publisher, subject, spatial, language, source, the item's own description (the richest text most of these items have) and its transcription where one exists.",
      inputSchema: z.object({
        keyword: z.string().optional().describe("Substring match across audiovisual title/metadata fields"),
        country: countryParam({ nigeria: true, note: "Burkina Faso, Togo, Benin and Nigeria only — no Niger or Ivorian items" }),
        language: z.string().optional().describe("Exact language value, e.g. Français | Haoussa | Arabe | Anglais | Mooré"),
        medium: z.string().optional().describe("Exact carrier medium: Vidéo sur le web | DVD | CD (validated, accents optional)"),
        subject: z.string().optional().describe("Exact subject tag"),
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
      const limit = resolveLimit(args.limit, 20, 50);
      const offset = capOffset(args.offset);
      const where: string[] = [];
      const params: Bindable[] = [];

      keywordFilter(schema, where, params, TEXT_COLS.audiovisual, args.keyword);
      pipeValueFilterIfExists(schema, where, params, "country", country.canonical);
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
        "List audiovisual materials (francophone web video from Burkina Faso, Togo and Benin; deposited Nigerian Hausa/Arabic recordings).",
      inputSchema: z.object({
        country: countryParam({ nigeria: true, note: "Burkina Faso, Togo, Benin and Nigeria only — no Niger or Ivorian items" }),
        limit: z.number().int().optional().describe("Default 20, max 50"),
        offset: z.number().int().optional(),
      }),
    },
    async (args) => {
      const schema = await ensureView("audiovisual");
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);
      const limit = resolveLimit(args.limit, 20, 50);
      const offset = capOffset(args.offset);
      const where: string[] = [];
      const params: Bindable[] = [];
      pipeValueFilterIfExists(schema, where, params, "country", country.canonical);

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
        "Get one audiovisual record by id, including its full description and transcription (where one exists), creator/publisher, media URL, duration, medium, subjects, places, language, source, and IWAC URL.",
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
