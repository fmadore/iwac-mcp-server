import { z } from "zod";
import { ensureView, q, query, queryOne, queryScalarSingle, viewName } from "../../db.js";
import type { Subset } from "../../config.js";
import { CHARTS_UI_META, VIEW } from "../appUi.js";
import {
  COUNTRIES,
  errorResult,
  structuredResult,
  toolMeta,
  validateEnum,
  type Server,
} from "../_shared.js";
import { AGG_SUBSETS, aggregateFilters, filterInputs } from "./shared.js";

/**
 * Columns worth ranking. An allowlist rather than an arbitrary column name:
 * it turns a typo into a listed set of alternatives instead of a SQL error,
 * and keeps the tool from being pointed at OCR or an embedding.
 */
const RANKABLE_FIELDS = ["subject", "spatial", "author", "language", "newspaper", "country"] as const;

/** Multi-value columns are pipe-joined; ranking one means exploding it first. */
const PIPE_FIELDS = new Set(["subject", "spatial", "author", "language", "country"]);

/** `unnest`-based explode of a pipe column into one trimmed, non-empty row per value. */
function explode(field: string): string {
  return PIPE_FIELDS.has(field)
    ? `unnest(str_split(coalesce(${q(field)}, ''), '|')) AS raw`
    : `${q(field)} AS raw`;
}

const FIELD_OUTPUT = z.object({
  view: z.string(),
  subset: z.string(),
  field: z.string(),
  filters: z.looseObject({}),
  total_matches: z.number(),
  items_with_value: z.number(),
  distinct_values: z.number(),
  values: z.array(z.looseObject({})),
  other_values: z.number().optional(),
  coverage_by_year: z.record(z.string(), z.looseObject({})).optional(),
  note: z.string().optional(),
});

const COOCCURRENCE_OUTPUT = z.object({
  view: z.string(),
  subset: z.string(),
  field: z.string(),
  filters: z.looseObject({}),
  total_matches: z.number(),
  values: z.array(z.looseObject({})),
  matrix: z.array(z.array(z.number())),
  top_pairs: z.array(z.looseObject({})),
  note: z.string().optional(),
});

export function registerDistributionsTools(server: Server): void {
  // === get_field_distribution =============================================
  server.registerTool(
    "get_field_distribution",
    {
      ...toolMeta("Rank a field's values"),
      description:
        "Rank the values of one multi-valued field across a filtered set — the direct way to answer 'which places " +
        "does this coverage name most', 'who signs these articles', 'what subjects dominate'. Pipe-joined fields " +
        "(subject, spatial, author, language, country) are split, so an article tagged 'Prière|Ramadan' counts " +
        "once for each. Optional over_time adds the per-year share of items that carry ANY value for the field, " +
        "which is how you see e.g. bylines appearing as the press professionalises.",
      _meta: CHARTS_UI_META,
      inputSchema: z.object({
        field: z.string().describe(RANKABLE_FIELDS.join(" | ")),
        subset: z.string().optional().describe("articles (default) | publications | references"),
        ...filterInputs(),
        top_n: z.number().int().optional().describe("Values returned (default 25, max 100)"),
        over_time: z.boolean().optional().describe("Also return the per-year share of items carrying a value"),
      }),
      outputSchema: FIELD_OUTPUT,
    },
    async (args) => {
      const subsetV = validateEnum(args.subset, AGG_SUBSETS, "subset");
      if (subsetV.err) return errorResult(subsetV.err);
      const subset = (subsetV.canonical ?? "articles") as Subset;
      const fieldV = validateEnum(args.field, RANKABLE_FIELDS, "field");
      if (fieldV.err) return errorResult(fieldV.err);
      const field = fieldV.canonical as string;
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);

      const schema = await ensureView(subset);
      if (!schema.has(field)) {
        return errorResult({
          error: `Field '${field}' is not available for subset '${subset}'`,
          valid_values: RANKABLE_FIELDS.filter((f) => schema.has(f)),
        });
      }
      const topN = Math.max(1, Math.min(100, args.top_n ?? 25));

      const filters = aggregateFilters(subset, schema, { ...args, country: country.canonical });
      if (filters.err) return errorResult(filters.err);
      const { where, params, echo } = filters;
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const totals = await queryOne(
        `SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE NULLIF(trim(${q(field)}), '') IS NOT NULL) AS filled
         FROM ${viewName(subset)} ${whereSql}`,
        params,
      );
      const total = Number(totals?.n ?? 0);
      const filled = Number(totals?.filled ?? 0);

      // One row per (item, value) pair, then count. `item_count` and `count`
      // differ only for a field that repeats a value within one item, which the
      // parquet does not do — but counting DISTINCT items keeps it true anyway.
      const exploded = `
        SELECT trim(raw) AS value, COUNT(*) AS count
        FROM (SELECT ${explode(field)} FROM ${viewName(subset)} ${whereSql})
        WHERE NULLIF(trim(raw), '') IS NOT NULL
        GROUP BY 1`;
      const rows = await query(`${exploded} ORDER BY count DESC, value LIMIT ${topN}`, params);
      const distinct = Number(
        (await queryScalarSingle<number | bigint>(`SELECT COUNT(*) FROM (${exploded})`, params)) ?? 0,
      );

      const payload: Record<string, unknown> = {
        view: VIEW.field,
        subset,
        field,
        filters: echo,
        total_matches: total,
        items_with_value: filled,
        distinct_values: distinct,
        values: rows.map((r) => ({ value: String(r.value), count: Number(r.count) })),
      };
      if (distinct > rows.length) payload.other_values = distinct - rows.length;

      if (args.over_time && schema.has("pub_date")) {
        const perYear = await query(
          `SELECT NULLIF(substr(CAST(pub_date AS VARCHAR), 1, 4), '') AS bucket, COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE NULLIF(trim(${q(field)}), '') IS NOT NULL) AS with_value
           FROM ${viewName(subset)} ${whereSql}
           GROUP BY 1 ORDER BY 1`,
          params,
        );
        const coverage: Record<string, unknown> = {};
        for (const r of perYear) {
          if (r.bucket == null) continue;
          coverage[String(r.bucket)] = { total: Number(r.total), with_value: Number(r.with_value) };
        }
        payload.coverage_by_year = coverage;
      }

      if (PIPE_FIELDS.has(field) && filled) {
        payload.note =
          `'${field}' is multi-valued: counts sum to more than ${filled} because an item with several values ` +
          `is counted under each.`;
      }
      return structuredResult(payload);
    },
  );

  // === get_cooccurrence ===================================================
  server.registerTool(
    "get_cooccurrence",
    {
      ...toolMeta("Co-occurrence matrix"),
      description:
        "How often the top values of a multi-valued field appear on the SAME item — a subject/place co-mention " +
        "matrix. Answers 'what is X discussed alongside' without reading anything: the pair counts are the " +
        "structure of the tagging. Returns the top values, the full symmetric matrix (diagonal = each value's own " +
        "count) and the strongest pairs.",
      _meta: CHARTS_UI_META,
      inputSchema: z.object({
        field: z.string().optional().describe("subject (default) | spatial | author | language"),
        subset: z.string().optional().describe("articles (default) | publications | references"),
        ...filterInputs(),
        top_n: z.number().int().optional().describe("Values on each axis (default 15, max 30)"),
      }),
      outputSchema: COOCCURRENCE_OUTPUT,
    },
    async (args) => {
      const subsetV = validateEnum(args.subset, AGG_SUBSETS, "subset");
      if (subsetV.err) return errorResult(subsetV.err);
      const subset = (subsetV.canonical ?? "articles") as Subset;
      const fieldV = validateEnum(args.field, ["subject", "spatial", "author", "language"] as const, "field");
      if (fieldV.err) return errorResult(fieldV.err);
      const field = (fieldV.canonical ?? "subject") as string;
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);

      const schema = await ensureView(subset);
      if (!schema.has(field)) {
        return errorResult({ error: `Field '${field}' is not available for subset '${subset}'` });
      }
      // 30 x 30 is 900 cells; beyond that the matrix stops being readable and
      // starts being a payload.
      const topN = Math.max(2, Math.min(30, args.top_n ?? 15));

      const filters = aggregateFilters(subset, schema, { ...args, country: country.canonical });
      if (filters.err) return errorResult(filters.err);
      const { where, params, echo } = filters;
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const total = Number(
        (await queryScalarSingle<number | bigint>(
          `SELECT COUNT(*) FROM ${viewName(subset)} ${whereSql}`,
          params,
        )) ?? 0,
      );

      // Explode once into (item, value), then self-join on the item. Restricting
      // to the top-N values BEFORE the join keeps it a 900-cell problem instead
      // of a 214x214 one.
      const pairs = `
        WITH v AS (
          SELECT "o:id" AS id, trim(raw) AS value
          FROM (SELECT "o:id", ${explode(field)} FROM ${viewName(subset)} ${whereSql})
          WHERE NULLIF(trim(raw), '') IS NOT NULL
        ),
        top AS (SELECT value, COUNT(DISTINCT id) AS n FROM v GROUP BY 1 ORDER BY n DESC, value LIMIT ${topN}),
        f AS (SELECT v.id, v.value FROM v JOIN top USING (value))
        SELECT a.value AS a, b.value AS b, COUNT(DISTINCT a.id) AS c
        FROM f a JOIN f b ON a.id = b.id
        GROUP BY 1, 2`;
      const [topRows, pairRows] = await Promise.all([
        query(
          `SELECT value, COUNT(DISTINCT id) AS n FROM (
             SELECT "o:id" AS id, trim(raw) AS value
             FROM (SELECT "o:id", ${explode(field)} FROM ${viewName(subset)} ${whereSql})
             WHERE NULLIF(trim(raw), '') IS NOT NULL
           ) GROUP BY 1 ORDER BY n DESC, value LIMIT ${topN}`,
          params,
        ),
        query(pairs, params),
      ]);

      const values = topRows.map((r) => String(r.value));
      const index = new Map(values.map((v, i) => [v, i]));
      const matrix: number[][] = values.map(() => values.map(() => 0));
      for (const r of pairRows) {
        const i = index.get(String(r.a));
        const j = index.get(String(r.b));
        if (i !== undefined && j !== undefined) matrix[i][j] = Number(r.c);
      }
      // Strongest pairs, upper triangle only — the matrix is symmetric, so
      // listing both halves would just repeat every pair.
      const topPairs = values
        .flatMap((a, i) => values.slice(i + 1).map((b, k) => ({ a, b, count: matrix[i][i + 1 + k] })))
        .filter((p) => p.count > 0)
        .sort((x, y) => y.count - x.count)
        .slice(0, 15);

      return structuredResult({
        view: VIEW.cooccurrence,
        subset,
        field,
        filters: echo,
        total_matches: total,
        values: topRows.map((r) => ({ value: String(r.value), count: Number(r.n) })),
        matrix,
        top_pairs: topPairs,
        note:
          `Matrix covers the ${values.length} most frequent '${field}' values only; pairs outside that set are ` +
          `not counted. The diagonal is each value's own item count.`,
      });
    },
  );

}
