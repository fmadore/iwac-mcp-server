import { z } from "zod";
import { ensureView, getById, q, selectList } from "../db.js";
import {
  annotate,
  capLimit,
  capOffset,
  errorResult,
  indexFreqOrder,
  indexSummaryCols,
  likeFilterIfExists,
  runListQuery,
  textResult,
  type Server,
} from "./_shared.js";

export function registerIndexTools(server: Server): void {
  // === search_index ========================================================
  server.registerTool(
    "search_index",
    {
      description: "Search the IWAC index (persons, places, organisations, events, subjects).",
      annotations: annotate("Search authority index"),
      inputSchema: {
        query: z.string().describe("Search term matched against Titre"),
        index_type: z
          .string()
          .optional()
          .describe("Personnes | Lieux | Organisations | Événements | Sujets"),
        limit: z.number().int().optional(),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const schema = await ensureView("index");
      const limit = capLimit(args.limit, 20, 100);
      const offset = capOffset(args.offset);
      const where: string[] = [`${q("Titre")} ILIKE ?`];
      const params: unknown[] = [`%${args.query}%`];
      if (args.index_type && schema.has("Type")) {
        where.push(`${q("Type")} ILIKE ?`);
        params.push(`%${args.index_type}%`);
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
      description: "Get full details of an index entry by o:id.",
      annotations: annotate("Get index entry details"),
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
  const inputSchema: Record<string, z.ZodTypeAny> = {
    limit: z.number().int().optional(),
    offset: z.number().int().optional(),
  };
  if (withCountry) inputSchema.country = z.string().optional();

  server.registerTool(
    name,
    {
      description: `List ${indexType.toLowerCase()} from the IWAC index, sorted by frequency.`,
      annotations: annotate(`List ${indexType.toLowerCase()} from the index`),
      inputSchema,
    },
    async (args: Record<string, unknown>) => {
      const schema = await ensureView("index");
      const limit = capLimit(args.limit as number | undefined, defaultLimit, maxLimit);
      const offset = capOffset(args.offset as number | undefined);
      const where: string[] = [`${q("Type")} = ?`];
      const params: unknown[] = [indexType];
      if (withCountry) {
        likeFilterIfExists(schema, where, params, "countries", args.country as string | undefined);
      }
      const cols = selectList(schema, [
        ['"o:id"', "o:id", ["o:id"]],
        "Titre",
        "Description",
        "frequency",
        ...(withCountry ? (["countries"] as const) : []),
        ["iwac_url", "url", ["iwac_url"]],
      ]);
      return textResult(
        await runListQuery({
          subset: "index",
          where,
          params,
          cols,
          orderBy: indexFreqOrder(schema),
          limit,
          offset,
        }),
      );
    },
  );
}
