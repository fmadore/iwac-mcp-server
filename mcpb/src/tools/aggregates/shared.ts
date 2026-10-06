import { z } from "zod";
import type { Bindable } from "../../db.js";
import type { Subset } from "../../config.js";
import { EXACT_FIELDS, type Selection } from "../../selection.js";
import { resolveSentimentModel, sentimentCols } from "../shared/sentiment.js";
import { q, query, viewName } from "../../db.js";
import { foldedEquals, pipeValueEquals } from "../shared/filters.js";
import { hijriFilter, requireHijriColumns, resolveHijriMonth } from "../shared/calendar.js";
import {
  COUNTRIES,
  validateEnum,
  dateRangeFilter,
  keywordFilter,
  likeFilterIfExists,
  pipeValueFilterIfExists,
  TEXT_COLS,
  validateDateBounds,
} from "../_shared.js";

/** Subsets these aggregates accept. `index` has no pub_date or subject. */
export const AGG_SUBSETS = ["articles", "publications", "references"] as const;

/**
 * The filter set every aggregate here accepts, applied identically to all of
 * them so a user can move between the charts without re-learning the inputs.
 */
export function aggregateFilters(
  subset: Subset,
  schema: Set<string>,
  args: Selection,
): {
  where: string[];
  params: Bindable[];
  echo: Record<string, unknown>;
  err?: { error: string; valid_values?: string[]; valid_format?: string };
} {
  const where: string[] = [];
  const params: Bindable[] = [];
  const echo = {
    keyword: args.keyword ?? null,
    ...(args.keyword_mode ? { keyword_mode: args.keyword_mode } : {}),
    ...(args.keyword_aliases?.length ? { keyword_aliases: args.keyword_aliases } : {}),
    country: args.country ?? null,
    newspaper: args.newspaper ?? null,
    subject: args.subject ?? null,
    date_from: args.date_from ?? null,
    date_to: args.date_to ?? null,
    ...(args.exact ? { exact: args.exact } : {}),
    ...(args.hijri_month ? { hijri_month: args.hijri_month } : {}),
    ...(args.hijri_year !== undefined ? { hijri_year: args.hijri_year } : {}),
  };

  const country = validateEnum(args.country, COUNTRIES, "country");
  if (country.err) return { where, params, echo, err: country.err };
  const dates = validateDateBounds(args.date_from, args.date_to);
  if (dates.err) return { where, params, echo, err: dates.err };
  if (args.keyword !== undefined && !args.keyword.trim())
    return { where, params, echo, err: { error: "keyword must contain a non-whitespace search term" } };
  if (args.keyword_mode === "all_terms" && !args.keyword?.trim())
    return { where, params, echo, err: { error: "all_terms requires a nonempty keyword" } };
  if (args.keyword_aliases?.some((term) => !term.trim()))
    return { where, params, echo, err: { error: "Keyword aliases must contain non-whitespace search terms" } };
  const unavailable = (field: string) => ({
    where,
    params,
    echo,
    err: { error: `Filter '${field}' is not available on subset '${subset}'` },
  });
  if (args.keyword && !TEXT_COLS[subset].some((c) => schema.has(c))) return unavailable("keyword");
  if ((args.date_from || args.date_to) && !schema.has("pub_date")) return unavailable("date");
  for (const [field, values] of Object.entries(args.exact ?? {})) {
    const sentiment = /^(polarity|centrality|subjectivity):(.+)$/.exec(field);
    const model = sentiment ? resolveSentimentModel(sentiment[2]) : undefined;
    if (sentiment && !model) return { where, params, echo, err: { error: `Unknown sentiment model: ${sentiment[2]}` } };
    if (!sentiment && !(EXACT_FIELDS as readonly string[]).includes(field))
      return { where, params, echo, err: { error: `Unknown exact field '${field}'`, valid_values: [...EXACT_FIELDS] } };
    if (field === "scored_by") {
      for (const id of values) {
        const m = resolveSentimentModel(id);
        const c = m && sentimentCols(m).polarity;
        if (!c || !schema.has(c)) return unavailable(`scored_by:${id}`);
        where.push(`NULLIF(TRIM(${q(c)}), '') IS NOT NULL`);
      }
      continue;
    }
    const col =
      model && sentiment
        ? sentimentCols(model)[sentiment[1] as "polarity" | "centrality" | "subjectivity"]
        : field === "topic_id"
          ? "lda_topic_id"
          : field === "min_prob"
            ? "lda_topic_prob"
            : field === "country_raw"
              ? "country"
              : field;
    if (!schema.has(col)) return unavailable(field);
    if (!Array.isArray(values) || !values.length || values.some((v) => typeof v !== "string" || !v.trim()))
      return { where, params, echo, err: { error: `Exact filter '${field}' needs nonempty values` } };
    for (const value of values) {
      if (field === "topic_id" || field === "min_prob") {
        const n = Number(value);
        if (!Number.isFinite(n) || (field === "topic_id" ? !Number.isInteger(n) : n < 0 || n > 1))
          return { where, params, echo, err: { error: `Invalid ${field}: ${value}` } };
        where.push(`${q(col)} ${field === "min_prob" ? ">=" : "="} ?`);
        params.push(n);
      } else {
        where.push(field === "newspaper" || field === "country_raw" ? foldedEquals(q(col)) : pipeValueEquals(q(col)));
        params.push(value);
      }
    }
  }
  const month = resolveHijriMonth(args.hijri_month);
  if (month.err) return { where, params, echo, err: month.err as { error: string } };
  if (month.n !== undefined || args.hijri_year !== undefined) {
    const missing = requireHijriColumns(schema, subset);
    if (missing) return { where, params, echo, err: missing };
    hijriFilter(where, params, month.n, args.hijri_year);
  }

  // A filter the subset cannot honour is an error, not a no-op. The `*IfExists`
  // helpers skip a missing column silently, which on `references` (no
  // `newspaper`) returned the ENTIRE subset while still echoing the filter —
  // the same silent-widening trap as a bad date bound. Ranking that column
  // already errors, so this just makes filtering agree with it.
  for (const [field, value] of [
    ["newspaper", args.newspaper],
    ["country", args.country],
    ["subject", args.subject],
  ] as const) {
    if (value && !schema.has(field)) {
      return {
        where,
        params,
        echo,
        err: {
          error: `Filter '${field}' is not available on subset '${subset}', so it cannot be applied`,
          valid_values: ["keyword", "date_from", "date_to"].concat(
            ["newspaper", "country", "subject"].filter((f) => schema.has(f)),
          ),
        },
      };
    }
  }

  const terms =
    args.keyword_mode === "all_terms"
      ? (args.keyword?.trim().split(/\s+/).filter(Boolean) ?? [])
      : args.keyword
        ? [args.keyword]
        : [];
  if (terms.length > 12) return { where, params, echo, err: { error: "all_terms supports at most 12 terms" } };
  if (args.keyword_aliases?.length) {
    if (!args.keyword || args.keyword_mode === "all_terms")
      return { where, params, echo, err: { error: "Aliases require a literal keyword" } };
    const alternatives: string[] = [];
    for (const term of [args.keyword, ...args.keyword_aliases]) {
      const w: string[] = [];
      keywordFilter(schema, w, params, TEXT_COLS[subset], term);
      alternatives.push(w.join(" AND "));
    }
    where.push(`(${alternatives.join(" OR ")})`);
  } else for (const term of terms) keywordFilter(schema, where, params, TEXT_COLS[subset], term);
  pipeValueFilterIfExists(schema, where, params, "country", country.canonical);
  likeFilterIfExists(schema, where, params, "newspaper", args.newspaper);
  pipeValueFilterIfExists(schema, where, params, "subject", args.subject);
  dateRangeFilter(schema, where, params, args.date_from, args.date_to);
  return { where, params, echo };
}

/** Shared input shape, so aggregate tools stay interchangeable to callers. */
export function filterInputs() {
  return {
    keyword: z.string().trim().min(1).optional(),
    country: z.string().optional().describe("Exact country name (accents optional)"),
    newspaper: z.string().optional().describe("Newspaper/periodical substring"),
    subject: z.string().optional().describe("Exact tag"),
    date_from: z.string().optional().describe("Inclusive date bounds: YYYY[-MM[-DD]]"),
    date_to: z.string().optional(),
    hijri_month: z.string().optional(),
    hijri_year: z.number().int().optional(),
    ...exactInput(),
  };
}

export function exactInput() {
  return {
    keyword_mode: z.enum(["literal", "all_terms"]).optional(),
    keyword_aliases: z.array(z.string().trim().min(1)).max(12).optional(),
    exact: z
      .record(z.string(), z.array(z.string()).min(1).max(20))
      .optional()
      .describe(
        "AND values. Fields: subject/spatial/author/language/country/newspaper/topic_id/min_prob/scored_by; country_raw=whole cell; polarity:<model>.",
      ),
  };
}

/** The filtered set as an aggregate's queries see it. */
export interface FilterScope {
  where: string[];
  params: Bindable[];
  /** `WHERE …`, or "" for an unfiltered call. */
  whereSql: string;
}

let scopeSeq = 0;
/** Scope tables whose DROP failed (a cancelled request); retried by the next scope. */
const orphanScopes = new Set<string>();

/**
 * Run an aggregate's queries over its filtered set with a keyword filter
 * evaluated ONCE.
 *
 * Every aggregate issues several queries over the same set (a total, the
 * distribution, a distinct count, a per-year series), and each re-ran the WHERE
 * clause. That is free for a country or subject filter and not for a keyword:
 * an accent-folded LIKE over the articles' OCR costs ~0.6 s a pass, so
 * get_field_distribution with a keyword and `over_time` took ~2.2 s for four
 * passes over the same rows. With a keyword, the matching ids go into a table
 * first and every query filters on that instead. Cheap filters skip the detour.
 *
 * An ordinary table in the shared in-memory catalog rather than a TEMP one:
 * connections carry no per-connection state, and any pooled connection must be
 * able to read it. `viewName()` already resolves to this request's pinned
 * snapshot, so the ids and the later queries see the same files.
 */
export async function withScope<T>(
  subset: Subset,
  filters: { where: string[]; params: Bindable[] },
  heavy: boolean,
  body: (scope: FilterScope) => Promise<T>,
): Promise<T> {
  const { where, params } = filters;
  if (!heavy || !where.length) {
    return body({ where, params, whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "" });
  }
  for (const orphan of orphanScopes) {
    await query(`DROP TABLE IF EXISTS ${orphan}`).then(() => orphanScopes.delete(orphan), () => {});
  }
  const table = `__scope_${process.pid}_${++scopeSeq}`;
  await query(`CREATE TABLE ${table} AS SELECT "o:id" AS __id FROM ${viewName(subset)} WHERE ${where.join(" AND ")}`, params);
  try {
    const scoped = `"o:id" IN (SELECT __id FROM ${table})`;
    return await body({ where: [scoped], params: [], whereSql: `WHERE ${scoped}` });
  } finally {
    await query(`DROP TABLE IF EXISTS ${table}`).catch(() => orphanScopes.add(table));
  }
}
