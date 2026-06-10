import { z } from "zod";
import { ensureView, selectList } from "../db.js";
import {
  annotate,
  capLimit,
  capOffset,
  countryFilterIfExists,
  pubDateOrder,
  runListQuery,
  textResult,
  type Server,
} from "./_shared.js";

export function registerAudiovisualTools(server: Server): void {
  // === list_audiovisual ====================================================
  server.registerTool(
    "list_audiovisual",
    {
      description:
        "List audiovisual materials (currently 45 Nigerian recordings, incl. Hausa/Arabic content).",
      annotations: annotate("List audiovisual materials"),
      inputSchema: {
        country: z.string().optional().describe("Exact country name (the subset is currently all Nigeria)"),
        limit: z.number().int().optional().describe("Default 20, max 50"),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const schema = await ensureView("audiovisual");
      const limit = capLimit(args.limit, 20, 50);
      const offset = capOffset(args.offset);
      const where: string[] = [];
      const params: unknown[] = [];
      countryFilterIfExists(schema, where, params, "country", args.country);

      const cols = selectList(schema, [
        ['"o:id"', "id", ["o:id"]],
        "title",
        "country",
        ["pub_date", "date", ["pub_date"]],
        ['"descriptionAI"', "description_ai", ["descriptionAI"]],
        "language",
        ["iwac_url", "url", ["iwac_url"]],
      ]);
      return textResult(
        await runListQuery({
          subset: "audiovisual",
          where,
          params,
          cols,
          orderBy: pubDateOrder(schema),
          limit,
          offset,
        }),
      );
    },
  );
}
