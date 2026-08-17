import { z } from "zod";
import { ensureView, q, query, queryOne, queryScalarSingle, viewName, type Bindable } from "../db.js";
import { ALL_SUBSETS, type Subset } from "../config.js";
import { CHARTS_UI_META, VIEW } from "./appUi.js";
import {
  COUNTRIES,
  countryParam,
  dateRangeFilter,
  DEFAULT_SENTIMENT_MODEL,
  errorResult,
  HIJRI_MONTHS,
  keywordFilter,
  likeFilterIfExists,
  pipeValueFilterIfExists,
  requireHijriColumns,
  rowsToMap,
  sentimentCols,
  structuredResult,
  TEXT_COLS,
  toolMeta,
  validateDateBounds,
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
// `lunar_month` collapses the year axis entirely — all Ramadans together, all
// Dhu al-Hijjas together. It is the one bucket a Gregorian axis structurally
// cannot produce: the lunar year drifts ~11 days a year, so over 1961-2025 a
// single lunar month smears across all twelve Gregorian ones. Only valid with
// calendar=hijri.
const GRANULARITIES = ["year", "month", "lunar_month"] as const;
const CALENDARS = ["gregorian", "hijri"] as const;
const GROUP_FIELDS = ["country", "newspaper"] as const;

// Output schemas (stats family): these tools have small, stable envelopes, so
// declaring outputSchema + returning structuredContent is cheap and gives
// programmatic clients a real contract. Row objects stay loose because visible
// columns vary with the dataset revision. NOTE: result compaction strips null
// values, so anything that can be null is `optional` here rather than nullable.
const COLLECTION_STATS_OUTPUT = z.object({
  view: z.string(),
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
});

const NEWSPAPER_STATS_OUTPUT = z.object({
  view: z.string(),
  country_filter: z.string().optional(),
  total_newspapers: z.number(),
  total_articles: z.number(),
  newspapers: z.array(z.looseObject({})),
});

const COUNTRY_COMPARISON_OUTPUT = z.object({
  view: z.string(),
  total_countries: z.number(),
  polarity_model: z.string().optional(),
  countries: z.array(z.looseObject({})),
});

const TEMPORAL_OUTPUT = z.object({
  view: z.string(),
  subset: z.string(),
  granularity: z.string(),
  calendar: z.string().optional(),
  group_by: z.string().optional(),
  filters: z.looseObject({}),
  total_matches: z.number(),
  dated_count: z.number(),
  undated_count: z.number(),
  // Hijri only: items that DO carry a Gregorian date but not a precise enough
  // one to place in a lunar month. Distinct from undated_count, and reported
  // separately so a lunar total is never mistaken for the subset total.
  imprecise_date_count: z.number().optional(),
  month_labels: z.record(z.string(), z.string()).optional(),
  distribution: z.record(z.string(), z.number()).optional(),
  distribution_by_group: z.record(z.string(), z.record(z.string(), z.number())).optional(),
  note: z.string().optional(),
});

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
      _meta: CHARTS_UI_META,
      inputSchema: z.object({}),
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
        view: VIEW.collection,
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
      _meta: CHARTS_UI_META,
      inputSchema: z.object({
        country: countryParam(),
      }),
      outputSchema: NEWSPAPER_STATS_OUTPUT,
    },
    async (args) => {
      const schema = await ensureView("articles");
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);
      if (!schema.has("newspaper")) {
        return structuredResult({
          view: VIEW.newspapers,
          country_filter: country.canonical ?? null,
          total_newspapers: 0,
          total_articles: 0,
          newspapers: [],
        });
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
        view: VIEW.newspapers,
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
        `Compare article counts, newspaper counts, date ranges, and ${DEFAULT_SENTIMENT_MODEL.id} polarity ` +
        "across countries.",
      _meta: CHARTS_UI_META,
      inputSchema: z.object({}),
      outputSchema: COUNTRY_COMPARISON_OUTPUT,
    },
    async () => {
      const schema = await ensureView("articles");
      if (!schema.has("country")) return structuredResult({ view: VIEW.countries, total_countries: 0, countries: [] });

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

      const polarityCol = sentimentCols(DEFAULT_SENTIMENT_MODEL).polarity;
      const polarityByCountry = new Map<string, Record<string, number>>();
      if (schema.has(polarityCol)) {
        const rows = await query(`
          SELECT country, ${q(polarityCol)} AS k, COUNT(*) AS c
          FROM ${viewName("articles")}
          WHERE NULLIF(trim(country), '') IS NOT NULL
          GROUP BY country, ${q(polarityCol)}
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
        if (pol && Object.keys(pol).length) rec.polarity = pol;
        return rec;
      });
      return structuredResult({
        view: VIEW.countries,
        total_countries: countries.length,
        // Name the annotator: this is one model's reading of every country, and
        // the panel disagrees often enough (all four unanimous on polarity for
        // ~36% of the corpus) that "the AI polarity" would be a claim the data
        // does not support.
        ...(schema.has(polarityCol) ? { polarity_model: DEFAULT_SENTIMENT_MODEL.id } : {}),
        countries,
      });
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
        "a bare-year key even at month granularity; undated items are counted in undated_count, never dropped silently. " +
        "Set calendar=hijri to bucket by the Islamic (Umm al-Qura) calendar instead — with granularity=lunar_month " +
        "this collapses every year into the twelve lunar months, which is the ONLY way to see observance-driven " +
        "coverage (Ramadan, Dhu al-Hijja/hajj, Shawwal/Korité): the lunar year drifts ~11 days against the Gregorian, " +
        "so a Gregorian axis smears each observance across all twelve months. Hijri buckets need a full YYYY-MM-DD, " +
        "so items dated only to a year or month are reported in imprecise_date_count.",
      // MCP Apps: hosts that support the extension render the counts as an
      // interactive chart (see tools/appUi.ts); everyone else ignores `_meta`
      // and gets the identical JSON.
      _meta: CHARTS_UI_META,
      inputSchema: z.object({
        subset: z
          .string()
          .optional()
          .describe("articles (default) | publications | references | documents | audiovisual"),
        granularity: z
          .string()
          .optional()
          .describe("year (default) | month | lunar_month (all years collapsed into 12 lunar months; needs calendar=hijri)"),
        calendar: z
          .string()
          .optional()
          .describe("gregorian (default) | hijri — bucket by the Islamic (Umm al-Qura) calendar"),
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
      }),
      outputSchema: TEMPORAL_OUTPUT,
    },
    async (args) => {
      const subsetV = validateEnum(args.subset, TEMPORAL_SUBSETS, "subset");
      if (subsetV.err) return errorResult(subsetV.err);
      const subset = (subsetV.canonical ?? "articles") as Subset;
      const granV = validateEnum(args.granularity, GRANULARITIES, "granularity");
      if (granV.err) return errorResult(granV.err);
      const calV = validateEnum(args.calendar, CALENDARS, "calendar");
      if (calV.err) return errorResult(calV.err);
      // `lunar_month` implies the Hijri calendar — there is no Gregorian
      // reading of it — so accept it without a redundant calendar=hijri
      // rather than bouncing the call back over a detail we can infer.
      const hijri = calV.canonical === "hijri" || granV.canonical === "lunar_month";
      const granularity = granV.canonical ?? "year";
      if (granularity === "lunar_month" && calV.canonical === "gregorian") {
        return errorResult({
          error: "granularity 'lunar_month' is a Hijri bucket; it cannot be combined with calendar='gregorian'.",
          note: "Drop the calendar argument (lunar_month implies hijri) or use granularity=month.",
        });
      }
      const groupV = validateEnum(args.group_by, GROUP_FIELDS, "group_by");
      if (groupV.err) return errorResult(groupV.err);
      const groupBy = groupV.canonical;
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);

      const schema = await ensureView(subset);
      if (!schema.has("pub_date")) {
        return errorResult({ error: `Subset '${subset}' has no pub_date column in this dataset revision` });
      }
      if (hijri) {
        const missing = requireHijriColumns(schema, subset);
        if (missing) return errorResult(missing);
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

      const dates = validateDateBounds(args.date_from, args.date_to);
      if (dates.err) return errorResult(dates.err);
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

      // Gregorian buckets slice the ISO string; Hijri buckets read the
      // precomputed columns (post-processing/calculate_hijri_dates.py), which
      // are NULL for any date too imprecise to carry a lunar day.
      let bucketExpr: string;
      if (!hijri) {
        bucketExpr = `NULLIF(substr(CAST(pub_date AS VARCHAR), 1, ${granularity === "month" ? 7 : 4}), '')`;
      } else if (granularity === "lunar_month") {
        bucketExpr = `lpad(CAST("hijri_month" AS VARCHAR), 2, '0')`;
      } else if (granularity === "month") {
        bucketExpr = `CAST("hijri_year" AS VARCHAR) || '-' || lpad(CAST("hijri_month" AS VARCHAR), 2, '0')`;
      } else {
        bucketExpr = `CAST("hijri_year" AS VARCHAR)`;
      }
      const groupSel = groupBy ? `, ${q(groupBy)} AS grp` : "";
      // `c_dated` splits the NULL-bucket rows: on the Hijri calendar a missing
      // bucket means EITHER no date at all OR a date too imprecise to convert,
      // and collapsing the two would let a lunar total read as the subset
      // total. One query answers both.
      const rows = await query(
        `SELECT ${bucketExpr} AS bucket${groupSel}, COUNT(*) AS c,
                COUNT(*) FILTER (WHERE NULLIF(trim(CAST(pub_date AS VARCHAR)), '') IS NOT NULL) AS c_dated
         FROM ${viewName(subset)} ${whereSql}
         GROUP BY ALL ORDER BY bucket`,
        params,
      );

      let dated = 0;
      let undated = 0;
      let imprecise = 0;
      let pipeGroups = false;
      const flat: Record<string, number> = {};
      const grouped: Record<string, Record<string, number>> = {};
      for (const r of rows) {
        const n = Number(r.c);
        const bucket = r.bucket == null ? null : String(r.bucket);
        if (bucket === null) {
          // Rows here carry a pub_date the calendar could not bucket — on the
          // Hijri side that is an imprecise date, not a missing one.
          const withDate = Number(r.c_dated ?? 0);
          imprecise += withDate;
          undated += n - withDate;
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
        // Which chart the MCP App should draw. Costs a handful of tokens and
        // is the app's only reliable dispatch signal; see tools/appUi.ts.
        view: granularity === "lunar_month" ? VIEW.lunar : VIEW.temporal,
        subset,
        granularity,
        ...(hijri ? { calendar: "hijri" } : {}),
        ...(groupBy ? { group_by: groupBy } : {}),
        filters: {
          keyword: args.keyword ?? null,
          country: country.canonical ?? null,
          newspaper: args.newspaper ?? null,
          subject: args.subject ?? null,
          date_from: args.date_from ?? null,
          date_to: args.date_to ?? null,
        },
        total_matches: dated + undated + imprecise,
        dated_count: dated,
        undated_count: undated,
        ...(imprecise ? { imprecise_date_count: imprecise } : {}),
        // The keys are zero-padded numbers so they sort; the model (and the
        // chart) should show names. Sending the table beats making either
        // hard-code a transliteration that would drift from the archive's.
        ...(granularity === "lunar_month"
          ? {
              month_labels: Object.fromEntries(
                HIJRI_MONTHS.map((m, i) => [String(i + 1).padStart(2, "0"), m]),
              ),
            }
          : {}),
        ...(groupBy ? { distribution_by_group: grouped } : { distribution: flat }),
      };
      const notes: string[] = [];
      if (pipeGroups) {
        notes.push(
          `Some ${groupBy} values are multi-valued (pipe-joined, e.g. 'Niger|Nigeria') and are grouped by the stored string.`,
        );
      }
      if (hijri && imprecise) {
        notes.push(
          `${imprecise} matching item(s) carry a date too imprecise for a lunar month (year- or month-only, or a range) ` +
            "and are excluded from the distribution — they are absent from these counts, not zero.",
        );
      }
      if (granularity === "lunar_month") {
        notes.push(
          "Counts are pooled across all Hijri years, so this shows the lunar cycle, not a trend over time. " +
            "It deliberately mixes Gregorian seasons — do not read it as seasonality.",
        );
      }
      if (notes.length) payload.note = notes.join(" ");
      return structuredResult(payload);
    },
  );
}
