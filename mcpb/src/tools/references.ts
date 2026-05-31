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

export function registerReferenceTools(server: Server): void {
  // === search_references ==================================================
  server.registerTool(
    "search_references",
    {
      description:
        "Search academic references (journal articles, books, theses) by title and abstract.",
      annotations: annotate("Search academic references"),
      inputSchema: {
        keyword: z.string().optional(),
        author: z.string().optional(),
        reference_type: z.string().optional(),
        limit: z.number().int().optional(),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const schema = await ensureView("references");
      const limit = capLimit(args.limit, 20, 100);
      const offset = capOffset(args.offset);
      const where: string[] = [];
      const params: unknown[] = [];

      if (args.keyword) {
        const parts: string[] = [];
        const kw = `%${args.keyword}%`;
        if (schema.has("title")) {
          parts.push("title ILIKE ?");
          params.push(kw);
        }
        if (schema.has("abstract")) {
          parts.push("abstract ILIKE ?");
          params.push(kw);
        }
        if (parts.length) where.push(`(${parts.join(" OR ")})`);
      }
      likeFilterIfExists(schema, where, params, "author", args.author);
      likeFilterIfExists(schema, where, params, "type", args.reference_type);

      const cols = selectList(schema, [
        ['"o:id"', "o:id", ["o:id"]],
        "title",
        "author",
        "type",
        ["pub_date", "date", ["pub_date"]],
        "publisher",
        ["iwac_url", "url", ["iwac_url"]],
      ]);
      return textResult(
        await runListQuery({
          subset: "references",
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
