import { z } from "zod";
import { ensureView, query, queryOne, queryScalarSingle, viewName } from "../db.js";
import { ALL_SUBSETS } from "../config.js";
import {
  annotate,
  likeFilterIfExists,
  rowsToMap,
  textResult,
  type Server,
} from "./_shared.js";

export function registerStatsTools(server: Server): void {
  // === get_collection_stats ===============================================
  server.registerTool(
    "get_collection_stats",
    {
      description: "Overall statistics for all six IWAC subsets.",
      annotations: annotate("Collection statistics"),
      inputSchema: {},
    },
    async () => {
      // Count every subset in parallel; a subset that fails to load is reported
      // as null (distinguishable from a genuine 0) rather than silently swallowed.
      const entries = await Promise.all(
        ALL_SUBSETS.map(async (s) => {
          try {
            await ensureView(s);
            const n = Number(
              (await queryScalarSingle<number | bigint>(`SELECT COUNT(*) FROM ${viewName(s)}`)) ?? 0,
            );
            return [s, n] as const;
          } catch {
            return [s, null] as const;
          }
        }),
      );
      const counts: Record<string, number | null> = {};
      for (const [s, n] of entries) counts[s] = n;

      const schema = await ensureView("articles");
      const payload: Record<string, unknown> = {
        collection_name: "Islam West Africa Collection (IWAC)",
        dataset_url: "https://huggingface.co/datasets/fmadore/islam-west-africa-collection",
        subset_counts: counts,
        total_records: Object.values(counts).reduce<number>((a, b) => a + (b ?? 0), 0),
      };
      if (schema.has("country")) {
        const rows = await query(
          `SELECT country AS k, COUNT(*) AS c FROM articles WHERE country IS NOT NULL GROUP BY country ORDER BY c DESC`,
        );
        payload.articles_by_country = rowsToMap(rows);
      }
      if (schema.has("newspaper")) {
        payload.newspaper_count = Number(
          (await queryScalarSingle<number | bigint>(
            `SELECT COUNT(DISTINCT newspaper) FROM articles WHERE newspaper IS NOT NULL`,
          )) ?? 0,
        );
      }
      if (schema.has("pub_date")) {
        const dateRow = await queryOne(
          `SELECT MIN(pub_date)::VARCHAR AS earliest, MAX(pub_date)::VARCHAR AS latest FROM articles WHERE pub_date IS NOT NULL`,
        );
        payload.date_range =
          dateRow && dateRow.earliest
            ? {
                earliest: String(dateRow.earliest).slice(0, 10),
                latest: String(dateRow.latest).slice(0, 10),
              }
            : null;
      }
      return textResult(payload);
    },
  );

  // === get_newspaper_stats ================================================
  server.registerTool(
    "get_newspaper_stats",
    {
      description: "Per-newspaper article counts and date ranges.",
      annotations: annotate("Newspaper statistics"),
      inputSchema: { country: z.string().optional() },
    },
    async (args) => {
      const schema = await ensureView("articles");
      const where: string[] = [];
      const params: unknown[] = [];
      likeFilterIfExists(schema, where, params, "country", args.country);
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const hasDate = schema.has("pub_date");
      const dateCols = hasDate
        ? ", MIN(pub_date)::VARCHAR AS earliest_date, MAX(pub_date)::VARCHAR AS latest_date"
        : "";
      const rows = await query(
        `SELECT newspaper, country, COUNT(*) AS article_count${dateCols}
         FROM articles ${whereSql}
         GROUP BY newspaper, country
         ORDER BY article_count DESC`,
        params,
      );
      const total = Number(
        (await queryScalarSingle<number | bigint>(
          `SELECT COUNT(*) FROM articles ${whereSql}`,
          params,
        )) ?? 0,
      );
      return textResult({
        country_filter: args.country ?? null,
        total_newspapers: rows.length,
        total_articles: total,
        newspapers: rows,
      });
    },
  );

  // === get_country_comparison ============================================
  server.registerTool(
    "get_country_comparison",
    {
      description:
        "Compare article counts, newspaper counts, date ranges, and Gemini polarity across countries.",
      annotations: annotate("Compare countries"),
      inputSchema: {},
    },
    async () => {
      const schema = await ensureView("articles");
      if (!schema.has("country")) return textResult({ total_countries: 0, countries: [] });

      const dateSel = schema.has("pub_date")
        ? ", MIN(pub_date)::VARCHAR AS earliest, MAX(pub_date)::VARCHAR AS latest"
        : "";
      const newsSel = schema.has("newspaper")
        ? ", COUNT(DISTINCT newspaper) AS newspaper_count"
        : "";
      const summary = await query(`
        SELECT country, COUNT(*) AS article_count${newsSel}${dateSel}
        FROM articles
        WHERE country IS NOT NULL
        GROUP BY country
        ORDER BY article_count DESC
      `);

      const polarityByCountry = new Map<string, Record<string, number>>();
      if (schema.has("gemini_polarite")) {
        const rows = await query(`
          SELECT country, gemini_polarite AS k, COUNT(*) AS c
          FROM articles
          WHERE country IS NOT NULL
          GROUP BY country, gemini_polarite
        `);
        for (const r of rows) {
          const c = String(r.country);
          const bucket = polarityByCountry.get(c) ?? {};
          if (r.k != null) bucket[String(r.k)] = Number(r.c);
          polarityByCountry.set(c, bucket);
        }
      }

      const countries = summary.map((r) => {
        const c = String(r.country);
        const rec: Record<string, unknown> = {
          country: c,
          article_count: Number(r.article_count),
        };
        if (schema.has("newspaper")) rec.newspaper_count = Number(r.newspaper_count);
        if (schema.has("pub_date") && r.earliest) {
          rec.date_range = {
            earliest: String(r.earliest).slice(0, 10),
            latest: String(r.latest).slice(0, 10),
          };
        }
        const pol = polarityByCountry.get(c);
        if (pol && Object.keys(pol).length) rec.gemini_polarity = pol;
        return rec;
      });
      return textResult({ total_countries: countries.length, countries });
    },
  );
}
