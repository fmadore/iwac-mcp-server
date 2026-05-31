import { z } from "zod";
import { ensureView, selectList } from "../db.js";
import {
  annotate,
  capLimit,
  capOffset,
  likeFilterIfExists,
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
      description: "List audiovisual materials.",
      annotations: annotate("List audiovisual materials"),
      inputSchema: {
        country: z.string().optional(),
        limit: z.number().int().optional(),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const schema = await ensureView("audiovisual");
      const limit = capLimit(args.limit, 20, 50);
      const offset = capOffset(args.offset);
      const where: string[] = [];
      const params: unknown[] = [];
      likeFilterIfExists(schema, where, params, "country", args.country);

      const cols = selectList(schema, [
        ['"o:id"', "o:id", ["o:id"]],
        "title",
        "country",
        ["pub_date", "date", ["pub_date"]],
        ['"descriptionAI"', "description", ["descriptionAI"]],
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
