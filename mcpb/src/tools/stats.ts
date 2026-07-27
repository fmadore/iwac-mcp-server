import { z } from "zod";
import { ensureView, q, query, queryOne, queryScalarSingle, viewName, type Bindable } from "../db.js";
import { ALL_SUBSETS, type Subset } from "../config.js";
import { COVERAGE_UI_META } from "./appUi.js";
import {
  COUNTRIES,
  countryParam,
  dateRangeFilter,
  errorResult,
  keywordFilter,
  likeFilterIfExists,
  pipeValueFilterIfExists,
  rowsToMap,
  structuredResult,
  TEXT_COLS,
  toolMeta,
  validateEnum,
  yearRangeFilter,
  type Server,
} from "./_shared.js";

// The parquet encodes missing values as empty strings, not NULLs, so date
// aggregates must NULLIF-guard or MIN() returns "" and the range collapses.
const DATE_EXPR = `NULLIF(trim(CAST(pub_date AS VARCHAR)), '')`;

// Subsets get_temporal_distribution accepts: everything with a pub_date column.
// (The index subset's first/last_occurrence mean something else entirely.)
const TEMPORAL_SUBSETS = ["articles", "publications", "references", "documents", "audiovisual", "images"] as const;
const GRANULARITIES = ["year", "month"] as const;
const GROUP_FIELDS = ["country", "newspaper"] as const;

// Output schemas (stats family): these tools have small, stable envelopes, so
// declaring outputSchema + returning structuredContent is cheap and gives
// programmatic clients a real contract. Row objects stay loose because visible
// columns vary with the dataset revision. NOTE: result compaction strips null
// values, so anything that can be null is `optional` here rather than nullable.
const COLLECTION_STATS_OUTPUT = {
  collection_name: z.string(),
  dataset_url: z.string(),
  subset_counts: z.record(z.string(), z.number()),
  failed_subsets: z.array(z.string()).optional(),
  total_records: z.number(),
  fulltext_coverage: z.record(z.string(), z.looseObject({})).optional(),
  fulltext_note: z.string().optional(),
  articles_by_country: z.record(z.string(), z.number()).optional(),
  newspaper_count: z.number().optional(),
  date_range: z.looseObject({ earliest: z.string(), latest: z.string() }).optional(),
};

const NEWSPAPER_STATS_OUTPUT = {
  country_filter: z.string().optional(),
  total_newspapers: z.number(),
  total_articles: z.number(),
  newspapers: z.array(z.looseObject({})),
};

const COUNTRY_COMPARISON_OUTPUT = {
  total_countries: z.number(),
  countries: z.array(z.looseObject({})),
};

const TEMPORAL_OUTPUT = {
  subset: z.string(),
  granularity: z.string(),
  group_by: z.string().optional(),
  filters: z.looseObject({}),
  total_matches: z.number(),
  dated_count: z.number(),
  undated_count: z.number(),
  distribution: z.record(z.string(), z.number()).optional(),
  distribution_by_group: z.record(z.string(), z.record(z.string(), z.number())).optional(),
  note: z.string().optional(),
};

export function registerStatsTools(server: Server): void {
  // === get_collection_stats ===============================================
  server.registerTool(
    "get_collection_stats",
    {
      ...toolMeta("Collection statistics"),
      description:
        "Overall statistics for every IWAC subset, including `fulltext_coverage` — how many items in each " +
        "subset actually carry searchable full text in this public dataset. Read that before treating any " +
        "keyword count as a full-text census.",
      inputSchema: {},
      outputSchema: COLLECTION_STATS_OUTPUT,
    },
    async () => {
      // Count every subset in parallel; a subset that fails to load is listed
      // in failed_subsets (a null count would be stripped by the result
      // compaction and read as silence) rather than swallowed. The articles
      // schema is captured from the same fan-out — re-awaiting ensureView after
      // a failure would retry the download OUTSIDE this error handling and
      // throw away the graceful envelope the fan-out just built.
      const entries = await Promise.all(
        ALL_SUBSETS.map(async (s) => {
          try {
            const schema = await ensureView(s);
            // Row count and full-text coverage in ONE pass. `OCR_is_public` is a
            // boolean column, so counting it costs 1-7 ms; the equivalent
            // `length(trim(OCR)) > 0` has to decompress the OCR column itself
            // (344 ms on publications) for an identical answer.
            const hasFlag = schema.has("OCR_is_public");
            const row = await queryOne(
              `SELECT COUNT(*) AS n${hasFlag ? `, COUNT(*) FILTER (WHERE "OCR_is_public") AS ft` : ""} FROM ${viewName(s)}`,
            );
            const n = Number(row?.n ?? 0);
            const ft = hasFlag ? Number(row?.ft ?? 0) : null;
            return [s, n, schema, ft] as const;
          } catch {
            return [s, null, null, null] as const;
          }
        }),
      );
      const counts: Record<string, number> = {};
      const failed: string[] = [];
      const coverage: Record<string, unknown> = {};
      for (const [s, n, , ft] of entries) {
        if (n === null) {
          failed.push(s);
          continue;
        }
        counts[s] = n;
        // The public dataset masks full text per row (the `OCR_is_public` flag
        // mirrors whether the source content is public on islam.zmo.de). Stating
        // the ratio is the difference between "1,200 articles mention charia"
        // meaning "of the whole corpus" and "of the 61% that are searchable".
        if (ft !== null && n > 0) {
          coverage[s] = { with_fulltext: ft, total: n, percent: Math.round((ft / n) * 100) };
        }
      }

      // Empty set when articles failed to load: the article-specific extras
      // below are skipped and the subset-count envelope still goes out.
      const schema = entries.find(([s]) => s === "articles")?.[2] ?? new Set<string>();
      const payload: Record<string, unknown> = {
        collection_name: "Islam West Africa Collection (IWAC)",
        dataset_url: "https://huggingface.co/datasets/fmadore/islam-west-africa-collection",
        subset_counts: counts,
        ...(failed.length ? { failed_subsets: failed } : {}),
        total_records: Object.values(counts).reduce<number>((a, b) => a + b, 0),
        ...(Object.keys(coverage).length
          ? {
              fulltext_coverage: coverage,
              fulltext_note:
                "This is the PUBLIC dataset: full text (OCR) ships only for items whose content is public on " +
                "islam.zmo.de, per item. Keyword search still reaches every item's title, subjects and AI " +
                "abstract, but the full-text half of a keyword match only covers the counts above — so report " +
                "keyword totals as a floor, not a corpus-wide census, and say so when the ratio matters.",
            }
          : {}),
      };
      if (schema.has("country")) {
        const rows = await query(
          `SELECT country AS k, COUNT(*) AS c FROM ${viewName("articles")} WHERE NULLIF(trim(country), '') IS NOT NULL GROUP BY country ORDER BY c DESC`,
        );
        payload.articles_by_country = rowsToMap(rows);
      }
      if (schema.has("newspaper")) {
        payload.newspaper_count = Number(
          (await queryScalarSingle<number | bigint>(
            `SELECT COUNT(DISTINCT NULLIF(trim(newspaper), '')) FROM ${viewName("articles")}`,
          )) ?? 0,
        );
      }
      if (schema.has("pub_date")) {
        const dateRow = await queryOne(
          `SELECT MIN(${DATE_EXPR}) AS earliest, MAX(${DATE_EXPR}) AS latest FROM ${viewName("articles")}`,
        );
        if (dateRow?.earliest) {
          payload.date_range = {
            earliest: String(dateRow.earliest).slice(0, 10),
            latest: String(dateRow.latest).slice(0, 10),
          };
        }
      }
      return structuredResult(payload);
    },
  );

  // === get_newspaper_stats ================================================
  server.registerTool(
    "get_newspaper_stats",
    {
      ...toolMeta("Newspaper statistics"),
      description: "Per-newspaper article counts and date ranges.",
      inputSchema: {
        country: countryParam(),
      },
      outputSchema: NEWSPAPER_STATS_OUTPUT,
    },
    async (args) => {
      const schema = await ensureView("articles");
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);
      if (!schema.has("newspaper")) {
        return structuredResult({ country_filter: country.canonical ?? null, total_newspapers: 0, total_articles: 0, newspapers: [] });
      }
      const where: string[] = [];
      const params: Bindable[] = [];
      pipeValueFilterIfExists(schema, where, params, "country", country.canonical);
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      // The parquet stores missing newspapers as "" — exclude them from the
      // per-newspaper grouping so a phantom empty-name row doesn't inflate
      // total_newspapers (get_collection_stats already counts distinct
      // non-empty names; the two tools must agree).
      const groupWhereSql = `WHERE ${[...where, `NULLIF(trim(newspaper), '') IS NOT NULL`].join(" AND ")}`;
      const hasDate = schema.has("pub_date");
      const dateCols = hasDate
        ? `, MIN(${DATE_EXPR}) AS earliest_date, MAX(${DATE_EXPR}) AS latest_date`
        : "";
      const rows = await query(
        `SELECT newspaper, country, COUNT(*) AS article_count${dateCols}
         FROM ${viewName("articles")} ${groupWhereSql}
         GROUP BY newspaper, country
         ORDER BY article_count DESC`,
        params,
      );
      const total = Number(
        (await queryScalarSingle<number | bigint>(
          `SELECT COUNT(*) FROM ${viewName("articles")} ${whereSql}`,
          params,
        )) ?? 0,
      );
      return structuredResult({
        country_filter: country.canonical ?? null,
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
      ...toolMeta("Compare countries"),
      description:
        "Compare article counts, newspaper counts, date ranges, and Gemini polarity across countries.",
      inputSchema: {},
      outputSchema: COUNTRY_COMPARISON_OUTPUT,
    },
    async () => {
      const schema = await ensureView("articles");
      if (!schema.has("country")) return structuredResult({ total_countries: 0, countries: [] });

      const dateSel = schema.has("pub_date")
        ? `, MIN(${DATE_EXPR}) AS earliest, MAX(${DATE_EXPR}) AS latest`
        : "";
      const newsSel = schema.has("newspaper")
        ? ", COUNT(DISTINCT NULLIF(trim(newspaper), '')) AS newspaper_count"
        : "";
      const summary = await query(`
        SELECT country, COUNT(*) AS article_count${newsSel}${dateSel}
        FROM ${viewName("articles")}
        WHERE NULLIF(trim(country), '') IS NOT NULL
        GROUP BY country
        ORDER BY article_count DESC
      `);

      const polarityByCountry = new Map<string, Record<string, number>>();
      if (schema.has("gemini_polarite")) {
        const rows = await query(`
          SELECT country, gemini_polarite AS k, COUNT(*) AS c
          FROM ${viewName("articles")}
          WHERE NULLIF(trim(country), '') IS NOT NULL
          GROUP BY country, gemini_polarite
        `);
        for (const r of rows) {
          const c = String(r.country);
          const bucket = polarityByCountry.get(c) ?? {};
          if (r.k != null && String(r.k).trim() !== "") bucket[String(r.k)] = Number(r.c);
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
      return structuredResult({ total_countries: countries.length, countries });
    },
  );

  // === get_temporal_distribution ==========================================
  server.registerTool(
    "get_temporal_distribution",
    {
      ...toolMeta("Coverage over time"),
      description:
        "Counts of matching items per year (or month) — the direct way to chart coverage trends over time " +
        "instead of paging through search results. Defaults to articles; also works on publications, references, " +
        "documents, audiovisual, and images. Accepts the same filters as the corresponding search_* tool " +
        "(keyword = ONE substring over the subset's text fields, country, newspaper/series, subject, date range). " +
        "Optional group_by=country|newspaper returns one distribution per group. Items dated only to a year keep " +
        "a bare-year key even at month granularity; undated items are counted in undated_count, never dropped silently.",
      // MCP Apps: hosts that support the extension render the counts as an
      // interactive chart (see tools/appUi.ts); everyone else ignores `_meta`
      // and gets the identical JSON.
      _meta: COVERAGE_UI_META,
      inputSchema: {
        subset: z
          .string()
          .optional()
          .describe("articles (default) | publications | references | documents | audiovisual"),
        granularity: z.string().optional().describe("year (default) | month"),
        keyword: z
          .string()
          .optional()
          .describe("ONE French concept keyword (French/English for references); substring over the subset's text fields"),
        country: countryParam({ nigeria: true }),
        newspaper: z.string().optional().describe("Newspaper (articles) or periodical/series title (publications)"),
        subject: z.string().optional().describe("Exact subject tag (pipe-aware)"),
        date_from: z.string().optional().describe("YYYY-MM-DD (or YYYY)"),
        date_to: z.string().optional().describe("YYYY-MM-DD (or YYYY)"),
        group_by: z.string().optional().describe("country | newspaper — one distribution per group value"),
      },
      outputSchema: TEMPORAL_OUTPUT,
    },
    async (args) => {
      const subsetV = validateEnum(args.subset, TEMPORAL_SUBSETS, "subset");
      if (subsetV.err) return errorResult(subsetV.err);
      const subset = (subsetV.canonical ?? "articles") as Subset;
      const granV = validateEnum(args.granularity, GRANULARITIES, "granularity");
      if (granV.err) return errorResult(granV.err);
      const granularity = granV.canonical ?? "year";
      const groupV = validateEnum(args.group_by, GROUP_FIELDS, "group_by");
      if (groupV.err) return errorResult(groupV.err);
      const groupBy = groupV.canonical;
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);

      const schema = await ensureView(subset);
      if (!schema.has("pub_date")) {
        return errorResult({ error: `Subset '${subset}' has no pub_date column in this dataset revision` });
      }
      if (groupBy && !schema.has(groupBy)) {
        return errorResult({
          error: `group_by '${groupBy}' is not available for subset '${subset}'`,
          valid_values: GROUP_FIELDS.filter((g) => schema.has(g)),
        });
      }

      // This is the one tool where the subset varies, so a supplied filter whose
      // column the subset lacks must be an error, not a silent no-op: the
      // *IfExists helpers would drop it and the distribution would cover the
      // WHOLE subset while the echoed `filters` claimed it was filtered — an
      // unfiltered aggregate presented as filtered, the inverse of the
      // silent-zero trap validateEnum exists to prevent.
      const inapplicable: string[] = [];
      if (args.keyword && !TEXT_COLS[subset].some((c) => schema.has(c))) inapplicable.push("keyword");
      if (country.canonical && !schema.has("country")) inapplicable.push("country");
      if (args.newspaper && !schema.has("newspaper")) inapplicable.push("newspaper");
      if (args.subject && !schema.has("subject")) inapplicable.push("subject");
      if (inapplicable.length) {
        return errorResult({
          error:
            `Filter${inapplicable.length > 1 ? "s" : ""} not available for subset '${subset}': ` +
            `${inapplicable.join(", ")}. Drop ${inapplicable.length > 1 ? "them" : "it"} or pick a subset that has ` +
            `the column${inapplicable.length > 1 ? "s" : ""}.`,
        });
      }

      const where: string[] = [];
      const params: Bindable[] = [];
      keywordFilter(schema, where, params, TEXT_COLS[subset], args.keyword);
      pipeValueFilterIfExists(schema, where, params, "country", country.canonical);
      likeFilterIfExists(schema, where, params, "newspaper", args.newspaper);
      pipeValueFilterIfExists(schema, where, params, "subject", args.subject);
      // Articles carry day-precision ISO dates; the other subsets store year-ish
      // VARCHARs ("1912"), where a lexicographic day compare would exclude them.
      if (subset === "articles") {
        dateRangeFilter(schema, where, params, args.date_from, args.date_to);
      } else {
        yearRangeFilter(schema, where, params, args.date_from, args.date_to);
      }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      const bucketLen = granularity === "month" ? 7 : 4;
      const bucketExpr = `NULLIF(substr(CAST(pub_date AS VARCHAR), 1, ${bucketLen}), '')`;
      const groupSel = groupBy ? `, ${q(groupBy)} AS grp` : "";
      const rows = await query(
        `SELECT ${bucketExpr} AS bucket${groupSel}, COUNT(*) AS c
         FROM ${viewName(subset)} ${whereSql}
         GROUP BY ALL ORDER BY bucket`,
        params,
      );

      let dated = 0;
      let undated = 0;
      let pipeGroups = false;
      const flat: Record<string, number> = {};
      const grouped: Record<string, Record<string, number>> = {};
      for (const r of rows) {
        const n = Number(r.c);
        const bucket = r.bucket == null ? null : String(r.bucket);
        if (bucket === null) {
          undated += n;
          continue;
        }
        dated += n;
        if (groupBy) {
          const g = r.grp == null || String(r.grp).trim() === "" ? "(none)" : String(r.grp);
          if (g.includes("|")) pipeGroups = true;
          grouped[g] ??= {};
          grouped[g][bucket] = (grouped[g][bucket] ?? 0) + n;
        } else {
          flat[bucket] = (flat[bucket] ?? 0) + n;
        }
      }

      const payload: Record<string, unknown> = {
        subset,
        granularity,
        ...(groupBy ? { group_by: groupBy } : {}),
        filters: {
          keyword: args.keyword ?? null,
          country: country.canonical ?? null,
          newspaper: args.newspaper ?? null,
          subject: args.subject ?? null,
          date_from: args.date_from ?? null,
          date_to: args.date_to ?? null,
        },
        total_matches: dated + undated,
        dated_count: dated,
        undated_count: undated,
        ...(groupBy ? { distribution_by_group: grouped } : { distribution: flat }),
      };
      if (pipeGroups) {
        payload.note =
          `Some ${groupBy} values are multi-valued (pipe-joined, e.g. 'Niger|Nigeria') and are grouped by the stored string.`;
      }
      return structuredResult(payload);
    },
  );
}
