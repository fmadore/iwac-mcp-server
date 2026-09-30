import { z } from "zod";
import type { Bindable } from "../../db.js";
import type { Subset } from "../../config.js";
import { EXACT_FIELDS, type Selection } from "../../selection.js";
import { resolveSentimentModel, sentimentCols } from "../shared/sentiment.js";
import { q } from "../../db.js";
import { foldedEquals, pipeValueEquals } from "../shared/filters.js";
import { hijriFilter, requireHijriColumns, resolveHijriMonth } from "../shared/calendar.js";
import {
  countryParam,
  COUNTRIES,
  validateEnum,
  dateRangeFilter,
  keywordFilter,
  likeFilterIfExists,
  pipeValueFilterIfExists,
  TEXT_COLS,
  validateDateBounds,
  yearRangeFilter,
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
        where.push(field === "newspaper" ? foldedEquals(q(col)) : pipeValueEquals(q(col)));
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
  if (subset === "articles") dateRangeFilter(schema, where, params, args.date_from, args.date_to);
  else yearRangeFilter(schema, where, params, args.date_from, args.date_to);
  return { where, params, echo };
}

/** Shared input shape, so aggregate tools stay interchangeable to callers. */
export function filterInputs() {
  return {
    keyword: z.string().optional().describe("ONE French concept keyword; substring over the subset's text fields"),
    country: countryParam({ nigeria: true }),
    newspaper: z.string().optional().describe("Newspaper (articles) or periodical/series title (publications)"),
    subject: z.string().optional().describe("Exact subject tag (pipe-aware)"),
    date_from: z.string().optional().describe("YYYY-MM-DD (or YYYY)"),
    date_to: z.string().optional().describe("YYYY-MM-DD (or YYYY)"),
    ...exactInput(),
  };
}

export function exactInput() {
  return {
    keyword_mode: z.enum(["literal", "all_terms"]).optional(),
    keyword_aliases: z
      .array(z.string().trim().min(1))
      .max(12)
      .optional()
      .describe("Explicit OR alternatives to literal keyword"),
    exact: z
      .record(z.string(), z.array(z.string()).min(1).max(20))
      .optional()
      .describe(
        "AND values: subject/spatial/author/language/country/newspaper/topic_id/min_prob; polarity:<model>; scored_by:[models].",
      ),
  };
}
