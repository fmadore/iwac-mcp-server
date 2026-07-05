import { z } from "zod";
import { ensureView, getById, q, selectList } from "../db.js";
import {
  capOffset,
  COUNTRIES,
  countryFilterIfExists,
  errorResult,
  foldedEquals,
  foldedLike,
  INDEX_TYPES,
  indexFreqOrder,
  indexSummaryCols,
  pipeValueEquals,
  resolveLimit,
  runListQuery,
  textResult,
  toolMeta,
  validateEnum,
  type Server,
} from "./_shared.js";

export function registerIndexTools(server: Server): void {
  // === search_index ========================================================
  server.registerTool(
    "search_index",
    {
      ...toolMeta("Search authority index"),
      description:
        "Search the IWAC authority index (persons, places, organisations, events, subjects) by name. " +
        "Accent/case-insensitive.",
      inputSchema: {
        keyword: z.string().describe("Search term matched against the entry title"),
        index_type: z
          .string()
          .optional()
          .describe(
            "Exact type (accents optional), validated against: Personnes | Lieux | Organisations | " +
              "Événements | Sujets | Notices d'autorité. An unrecognised value returns an error listing the valid types.",
          ),
        limit: z.number().int().optional().describe("Default 20, max 100"),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const schema = await ensureView("index");
      const indexType = validateEnum(args.index_type, INDEX_TYPES, "index_type");
      if (indexType.err) return errorResult(indexType.err);
      const limit = resolveLimit(args.limit, 20, 100);
      const offset = capOffset(args.offset);
      const namePredicates = [foldedLike(q("Titre"))];
      const params: unknown[] = [`%${args.keyword}%`];
      if (schema.has("Titre alternatif")) {
        namePredicates.push(pipeValueEquals(q("Titre alternatif")));
        params.push(args.keyword);
      }
      const where: string[] = [`(${namePredicates.join(" OR ")})`];
      if (indexType.canonical && schema.has("Type")) {
        where.push(foldedEquals(q("Type")));
        params.push(indexType.canonical);
      }
      return textResult(
        await runListQuery({
          subset: "index",
          where,
          params,
          cols: indexSummaryCols(schema),
          orderBy: indexFreqOrder(schema),
          limit,
          offset,
        }),
      );
    },
  );

  // === get_index_entry =====================================================
  server.registerTool(
    "get_index_entry",
    {
      ...toolMeta("Get index entry details"),
      description:
        "Get full details of an index entry by id (raw dataset columns, French names — Titre, Prénom, Coordonnées…).",
      inputSchema: { entry_id: z.number().int() },
    },
    async ({ entry_id }) => {
      await ensureView("index");
      const row = await getById("index", "*", entry_id);
      if (!row) return errorResult({ error: `Index entry ${entry_id} not found` });
      return textResult(row);
    },
  );

  // === list_subjects / list_locations / list_persons =======================
  registerIndexListTool(server, "list_subjects", "Sujets", false, 50, 200);
  registerIndexListTool(server, "list_locations", "Lieux", true, 50, 200);
  registerIndexListTool(server, "list_persons", "Personnes", true, 50, 200);
}

// -----------------------------------------------------------------------------
// Generic "list one index Type, ranked by frequency" tool
// -----------------------------------------------------------------------------

function registerIndexListTool(
  server: Server,
  name: "list_subjects" | "list_locations" | "list_persons",
  indexType: string,
  withCountry: boolean,
  defaultLimit: number,
  maxLimit: number,
): void {
  const typeLower = indexType.toLowerCase();
  const inputSchema: Record<string, z.ZodTypeAny> = {
    limit: z.number().int().optional().describe(`Default ${defaultLimit}, max ${maxLimit}`),
    offset: z.number().int().optional(),
  };
  if (withCountry) {
    inputSchema.country = z
      .string()
      .optional()
      .describe(
        "Exact country name: Benin | Burkina Faso | Côte d'Ivoire | Niger | Nigeria | Togo (accents optional). " +
          `Selects ${typeLower} MENTIONED IN records from that country, not entities located there.`,
      );
  }

  // For the country-filtered lists, spell out the semantics that surprised testers:
  // the filter is "appears in records from country X", not "located in X", and the
  // frequency ranking is collection-wide, so foreign places (e.g. La Mecque) and
  // high-frequency entries from elsewhere legitimately appear under a country filter.
  const countrySemantics = withCountry
    ? ` The optional 'country' filter selects entries that APPEAR IN records from that country ` +
      `(mentioned-in, not located-in), ranked by collection-wide 'frequency' — so foreign and ` +
      `cross-border entries can appear. Nigeria returns none here (index frequency is computed from ` +
      `articles + publications + references, which have no Nigerian items — Nigeria is audiovisual only).`
    : "";

  server.registerTool(
    name,
    {
      ...toolMeta(`List ${typeLower} from the index`),
      description: `List ${typeLower} from the IWAC index, sorted by frequency (most-referenced first).${countrySemantics}`,
      inputSchema,
    },
    async (args: Record<string, unknown>) => {
      const schema = await ensureView("index");
      const country = validateEnum(args.country as string | undefined, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);
      const limit = resolveLimit(args.limit as number | undefined, defaultLimit, maxLimit);
      const offset = capOffset(args.offset as number | undefined);
      const where: string[] = [`${q("Type")} = ?`];
      const params: unknown[] = [indexType];
      if (withCountry) {
        countryFilterIfExists(schema, where, params, "countries", country.canonical);
      }
      const cols = selectList(schema, [
        ['"o:id"', "id", ["o:id"]],
        [q("Titre"), "title", ["Titre"]],
        [q("Description"), "description", ["Description"]],
        "frequency",
        ...(withCountry ? (["countries"] as const) : []),
        ["iwac_url", "url", ["iwac_url"]],
      ]);
      const env = await runListQuery({
        subset: "index",
        where,
        params,
        cols,
        orderBy: indexFreqOrder(schema),
        limit,
        offset,
      });
      if (withCountry && country.canonical) {
        env.note =
          `country filters to ${typeLower} that appear in records from ${country.canonical} ` +
          `(mentioned-in, not located-in); 'frequency' is each entry's collection-wide total, not a count within ${country.canonical}.`;
      }
      return textResult(env);
    },
  );
}
