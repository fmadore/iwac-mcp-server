// Corpus-level aggregates: topics, field rankings, co-occurrence, press language.
//
// Everything here is one SQL pass over the cached parquet — columns that exist
// in the dataset today but that no tool exposed, so they were invisible to
// every client. See docs/mcp-apps-roadmap.md §3 for the inventory that
// motivated each one.
//
// FOUR tools, not six. The roadmap floated a named tool per chart (place
// ranking, bylines, subject co-occurrence, press language) and then asked
// whether that earns its place in every client's tool list. It does not:
// "rank the values of a multi-valued column" is ONE operation that answers
// place ranking, top authors, subject frequency and language mix, so those
// collapse into get_field_distribution. Co-occurrence (pairs) and the lexical
// metrics (numeric summaries) are genuinely different shapes and stay separate.
import { z } from "zod";
import { ensureView, q, query, queryOne, queryScalarSingle, viewName, type Bindable } from "../db.js";
import type { Subset } from "../config.js";
import { CHARTS_UI_META, VIEW } from "./appUi.js";
import {
  COUNTRIES,
  countryParam,
  dateRangeFilter,
  errorResult,
  keywordFilter,
  likeFilterIfExists,
  pipeValueFilterIfExists,
  structuredResult,
  TEXT_COLS,
  toolMeta,
  validateEnum,
  yearRangeFilter,
  type Server,
} from "./_shared.js";

/**
 * Columns worth ranking. An allowlist rather than an arbitrary column name:
 * it turns a typo into a listed set of alternatives instead of a SQL error,
 * and keeps the tool from being pointed at OCR or an embedding.
 */
const RANKABLE_FIELDS = ["subject", "spatial", "author", "language", "newspaper", "country"] as const;

/** Subsets these aggregates accept. `index` has no pub_date or subject. */
const AGG_SUBSETS = ["articles", "publications", "references"] as const;

const GROUP_FIELDS = ["year", "newspaper", "country"] as const;

/** The three AI sentiment models the dataset carries, all at 100% coverage. */
export const SENTIMENT_MODELS = ["gemini", "chatgpt", "mistral"] as const;

/** Multi-value columns are pipe-joined; ranking one means exploding it first. */
const PIPE_FIELDS = new Set(["subject", "spatial", "author", "language", "country"]);

/** `unnest`-based explode of a pipe column into one trimmed, non-empty row per value. */
function explode(field: string): string {
  return PIPE_FIELDS.has(field)
    ? `unnest(str_split(coalesce(${q(field)}, ''), '|')) AS raw`
    : `${q(field)} AS raw`;
}

const TOPIC_OUTPUT = {
  view: z.string(),
  subset: z.string(),
  filters: z.looseObject({}),
  total_matches: z.number(),
  classified: z.number(),
  topics: z.array(z.looseObject({})),
  periods: z.array(z.string()).optional(),
  series_by_topic: z.record(z.string(), z.record(z.string(), z.number())).optional(),
  note: z.string().optional(),
};

const FIELD_OUTPUT = {
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
};

const COOCCURRENCE_OUTPUT = {
  view: z.string(),
  subset: z.string(),
  field: z.string(),
  filters: z.looseObject({}),
  total_matches: z.number(),
  values: z.array(z.looseObject({})),
  matrix: z.array(z.array(z.number())),
  top_pairs: z.array(z.looseObject({})),
  note: z.string().optional(),
};

const LEXICAL_OUTPUT = {
  view: z.string(),
  group_by: z.string(),
  filters: z.looseObject({}),
  total_matches: z.number(),
  groups: z.array(z.looseObject({})),
  metrics: z.record(z.string(), z.looseObject({})),
  readability_excluded: z.number().optional(),
  note: z.string().optional(),
};

/**
 * The filter set every aggregate here accepts, applied identically to all of
 * them so a user can move between the charts without re-learning the inputs.
 */
function aggregateFilters(
  subset: Subset,
  schema: Set<string>,
  args: {
    keyword?: string;
    country?: string;
    newspaper?: string;
    subject?: string;
    date_from?: string;
    date_to?: string;
  },
): { where: string[]; params: Bindable[]; echo: Record<string, unknown> } {
  const where: string[] = [];
  const params: Bindable[] = [];
  keywordFilter(schema, where, params, TEXT_COLS[subset], args.keyword);
  pipeValueFilterIfExists(schema, where, params, "country", args.country);
  likeFilterIfExists(schema, where, params, "newspaper", args.newspaper);
  pipeValueFilterIfExists(schema, where, params, "subject", args.subject);
  if (subset === "articles") dateRangeFilter(schema, where, params, args.date_from, args.date_to);
  else yearRangeFilter(schema, where, params, args.date_from, args.date_to);
  return {
    where,
    params,
    echo: {
      keyword: args.keyword ?? null,
      country: args.country ?? null,
      newspaper: args.newspaper ?? null,
      subject: args.subject ?? null,
      date_from: args.date_from ?? null,
      date_to: args.date_to ?? null,
    },
  };
}

/** Shared input shape, so the four tools stay interchangeable to callers. */
function filterInputs() {
  return {
    keyword: z.string().optional().describe("ONE French concept keyword; substring over the subset's text fields"),
    country: countryParam({ nigeria: true }),
    newspaper: z.string().optional().describe("Newspaper (articles) or periodical/series title (publications)"),
    subject: z.string().optional().describe("Exact subject tag (pipe-aware)"),
    date_from: z.string().optional().describe("YYYY-MM-DD (or YYYY)"),
    date_to: z.string().optional().describe("YYYY-MM-DD (or YYYY)"),
  };
}

export function registerAggregateTools(server: Server): void {
  // === get_topic_distribution =============================================
  server.registerTool(
    "get_topic_distribution",
    {
      ...toolMeta("Topic distribution"),
      description:
        "How a filtered set of articles distributes across the 30 precomputed LDA topics, each labelled by its " +
        "top terms. Topics are assigned offline over the full text, so they describe what a piece is ABOUT rather " +
        "than which words it contains — use this instead of keyword counting to map a corpus. " +
        "Optional over_time returns per-year counts for the leading topics. " +
        "min_prob keeps only articles where the topic is at least that dominant (mean assignment probability is " +
        "0.34, so 0.5 is already a strong filter).",
      _meta: CHARTS_UI_META,
      inputSchema: {
        subset: z.string().optional().describe("articles (default) | references"),
        ...filterInputs(),
        min_prob: z.number().optional().describe("0-1; keep only assignments at or above this probability"),
        over_time: z.boolean().optional().describe("Also return per-year counts for the leading topics"),
        top_n: z.number().int().optional().describe("Topics given their own band in over_time (default 8, max 15)"),
      },
      outputSchema: TOPIC_OUTPUT,
    },
    async (args) => {
      const subsetV = validateEnum(args.subset, ["articles", "references"] as const, "subset");
      if (subsetV.err) return errorResult(subsetV.err);
      const subset = (subsetV.canonical ?? "articles") as Subset;
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);

      const schema = await ensureView(subset);
      if (!schema.has("lda_topic_label")) {
        return errorResult({
          error: `Subset '${subset}' carries no LDA topic columns in this dataset revision`,
          valid_values: ["articles"],
        });
      }

      const { where, params, echo } = aggregateFilters(subset, schema, { ...args, country: country.canonical });
      const total = Number(
        (await queryScalarSingle<number | bigint>(
          `SELECT COUNT(*) FROM ${viewName(subset)} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`,
          params,
        )) ?? 0,
      );

      // Topic rows only: an unclassified article (no label) is not a topic of
      // its own, and -1 is the outlier marker in the pipeline's convention.
      const topicWhere = [
        ...where,
        `NULLIF(trim(lda_topic_label), '') IS NOT NULL`,
        `coalesce(lda_topic_id, 0) <> -1`,
      ];
      const topicParams = [...params];
      if (typeof args.min_prob === "number" && Number.isFinite(args.min_prob)) {
        topicWhere.push(`coalesce(lda_topic_prob, 0) >= ?`);
        topicParams.push(Math.max(0, Math.min(1, args.min_prob)));
      }
      const topicWhereSql = `WHERE ${topicWhere.join(" AND ")}`;

      const rows = await query(
        `SELECT lda_topic_label AS label, CAST(coalesce(lda_topic_id, -1) AS INTEGER) AS topic_id,
                COUNT(*) AS count, ROUND(AVG(lda_topic_prob), 3) AS avg_prob
         FROM ${viewName(subset)} ${topicWhereSql}
         GROUP BY 1, 2 ORDER BY count DESC`,
        topicParams,
      );
      const classified = rows.reduce((a, r) => a + Number(r.count), 0);

      const payload: Record<string, unknown> = {
        view: VIEW.topics,
        subset,
        filters: { ...echo, min_prob: args.min_prob ?? null },
        total_matches: total,
        classified,
        topics: rows.map((r) => ({
          topic_id: Number(r.topic_id),
          label: String(r.label),
          count: Number(r.count),
          avg_prob: Number(r.avg_prob),
        })),
      };

      if (args.over_time && schema.has("pub_date")) {
        const topN = Math.max(1, Math.min(15, args.top_n ?? 8));
        const leading = rows.slice(0, topN).map((r) => String(r.label));
        const perYear = await query(
          `SELECT NULLIF(substr(CAST(pub_date AS VARCHAR), 1, 4), '') AS bucket,
                  lda_topic_label AS label, COUNT(*) AS c
           FROM ${viewName(subset)} ${topicWhereSql}
           GROUP BY ALL ORDER BY bucket`,
          topicParams,
        );
        // Everything past the top N collapses into one band rather than being
        // dropped: a stacked area whose bands do not sum to the total lies.
        const OTHER = "(other topics)";
        const leadingSet = new Set(leading);
        const series: Record<string, Record<string, number>> = {};
        const periods = new Set<string>();
        for (const r of perYear) {
          if (r.bucket == null) continue;
          const bucket = String(r.bucket);
          periods.add(bucket);
          const key = leadingSet.has(String(r.label)) ? String(r.label) : OTHER;
          series[key] ??= {};
          series[key][bucket] = (series[key][bucket] ?? 0) + Number(r.c);
        }
        payload.periods = [...periods].sort();
        payload.series_by_topic = series;
        if (rows.length > topN) {
          payload.note =
            `Over-time bands cover the ${topN} largest topics; the remaining ${rows.length - topN} are summed ` +
            `into "${OTHER}" so the bands still total the classified count.`;
        }
      }

      if (classified < total) {
        payload.note =
          `${total - classified} of ${total} matching items carry no topic assignment` +
          (args.min_prob ? ` at min_prob ${args.min_prob}` : "") +
          ` and are not in the distribution.` +
          (payload.note ? ` ${payload.note}` : "");
      }
      return structuredResult(payload);
    },
  );

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
      inputSchema: {
        field: z.string().describe(RANKABLE_FIELDS.join(" | ")),
        subset: z.string().optional().describe("articles (default) | publications | references"),
        ...filterInputs(),
        top_n: z.number().int().optional().describe("Values returned (default 25, max 100)"),
        over_time: z.boolean().optional().describe("Also return the per-year share of items carrying a value"),
      },
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

      const { where, params, echo } = aggregateFilters(subset, schema, { ...args, country: country.canonical });
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
      inputSchema: {
        field: z.string().optional().describe("subject (default) | spatial | author | language"),
        subset: z.string().optional().describe("articles (default) | publications | references"),
        ...filterInputs(),
        top_n: z.number().int().optional().describe("Values on each axis (default 15, max 30)"),
      },
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

      const { where, params, echo } = aggregateFilters(subset, schema, { ...args, country: country.canonical });
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

  // === get_lexical_metrics ================================================
  server.registerTool(
    "get_lexical_metrics",
    {
      ...toolMeta("Press language metrics"),
      description:
        "Readability, lexical richness and length of the press text, averaged by year, newspaper or country. " +
        "`Lisibilite_OCR` is a French readability score (higher = easier); `Richesse_Lexicale_OCR` is MATTR, a " +
        "moving-average type-token ratio that is ALREADY length-robust — do not normalise it by word count or " +
        "bin it by length. Readability is computed against a French lexicon, so non-French items are excluded " +
        "from that metric (and counted in readability_excluded) rather than reported as unreadable; MATTR and " +
        "word count need no lexicon and cover everything. Only items whose full text ships in this public " +
        "dataset carry these columns at all.",
      _meta: CHARTS_UI_META,
      inputSchema: {
        group_by: z.string().optional().describe("year (default) | newspaper | country"),
        ...filterInputs(),
        top_n: z.number().int().optional().describe("Groups returned when grouping by newspaper (default 20, max 60)"),
      },
      outputSchema: LEXICAL_OUTPUT,
    },
    async (args) => {
      const groupV = validateEnum(args.group_by, GROUP_FIELDS, "group_by");
      if (groupV.err) return errorResult(groupV.err);
      const groupBy = groupV.canonical ?? "year";
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);

      const schema = await ensureView("articles");
      const METRICS: [string, string][] = [
        ["Lisibilite_OCR", "readability"],
        ["Richesse_Lexicale_OCR", "mattr"],
        ["nb_mots", "words"],
      ];
      const present = METRICS.filter(([col]) => schema.has(col));
      if (!present.length) {
        return errorResult({ error: "This dataset revision carries no lexical metric columns" });
      }
      if (groupBy !== "year" && !schema.has(groupBy)) {
        return errorResult({
          error: `group_by '${groupBy}' is not available`,
          valid_values: GROUP_FIELDS.filter((g) => g === "year" || schema.has(g)),
        });
      }
      const topN = Math.max(1, Math.min(60, args.top_n ?? 20));

      const { where, params, echo } = aggregateFilters("articles", schema, { ...args, country: country.canonical });
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const groupExpr =
        groupBy === "year" ? `NULLIF(substr(CAST(pub_date AS VARCHAR), 1, 4), '')` : `NULLIF(trim(${q(groupBy)}), '')`;

      // Readability is French-lexicon based, so a Dendi or English item scores
      // as "hard" for reasons that have nothing to do with its prose. Excluding
      // it from THAT metric only is the honest fix: MATTR is a type-token ratio
      // and needs no lexicon, so it stays valid for every language.
      const frenchOnly = schema.has("language")
        ? `CASE WHEN coalesce(NULLIF(trim(language), ''), 'Français') ILIKE '%français%' THEN "Lisibilite_OCR" END`
        : `"Lisibilite_OCR"`;

      const selects = present
        .map(([col, name]) =>
          name === "readability"
            ? `ROUND(AVG(${frenchOnly}), 2) AS ${name}_avg, ROUND(median(${frenchOnly}), 2) AS ${name}_median, ` +
              `COUNT(${frenchOnly}) AS ${name}_n`
            : `ROUND(AVG(${q(col)}), ${name === "words" ? 0 : 3}) AS ${name}_avg, ` +
              `ROUND(median(${q(col)}), ${name === "words" ? 0 : 3}) AS ${name}_median, ` +
              `COUNT(${q(col)}) AS ${name}_n`,
        )
        .join(", ");

      const order = groupBy === "year" ? "ORDER BY grp" : `ORDER BY items DESC LIMIT ${topN}`;
      const rows = await query(
        `SELECT ${groupExpr} AS grp, COUNT(*) AS items, ${selects}
         FROM ${viewName("articles")} ${whereSql}
         GROUP BY 1 HAVING ${groupExpr} IS NOT NULL ${order}`,
        params,
      );
      const total = Number(
        (await queryScalarSingle<number | bigint>(
          `SELECT COUNT(*) FROM ${viewName("articles")} ${whereSql}`,
          params,
        )) ?? 0,
      );
      const excluded = schema.has("language")
        ? Number(
            (await queryScalarSingle<number | bigint>(
              `SELECT COUNT(*) FROM ${viewName("articles")} ${whereSql}${whereSql ? " AND" : " WHERE"} ` +
                `"Lisibilite_OCR" IS NOT NULL AND NULLIF(trim(language), '') IS NOT NULL ` +
                `AND language NOT ILIKE '%français%'`,
              params,
            )) ?? 0,
          )
        : 0;

      const payload: Record<string, unknown> = {
        view: VIEW.lexical,
        group_by: groupBy,
        filters: echo,
        total_matches: total,
        groups: rows.map((r) => {
          const rec: Record<string, unknown> = { group: String(r.grp), items: Number(r.items) };
          for (const [, name] of present) {
            if (r[`${name}_avg`] != null) rec[`${name}_avg`] = Number(r[`${name}_avg`]);
            if (r[`${name}_median`] != null) rec[`${name}_median`] = Number(r[`${name}_median`]);
            rec[`${name}_n`] = Number(r[`${name}_n`] ?? 0);
          }
          return rec;
        }),
        metrics: {
          ...(present.some(([, n]) => n === "readability")
            ? { readability: { label: "Readability (French)", higher_is: "easier", range: "0-100" } }
            : {}),
          ...(present.some(([, n]) => n === "mattr")
            ? { mattr: { label: "Lexical richness (MATTR)", higher_is: "more varied", range: "0-1" } }
            : {}),
          ...(present.some(([, n]) => n === "words") ? { words: { label: "Words per item", higher_is: "longer" } } : {}),
        },
      };
      if (excluded) payload.readability_excluded = excluded;
      if (groupBy === "newspaper" && rows.length >= topN) {
        payload.note = `Showing the ${topN} newspapers with the most matching items.`;
      }
      return structuredResult(payload);
    },
  );
}
