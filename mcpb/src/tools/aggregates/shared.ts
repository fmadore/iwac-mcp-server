import { z } from "zod";
import type { Bindable } from "../../db.js";
import type { Subset } from "../../config.js";
import {
  countryParam,
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
  args: {
    keyword?: string;
    country?: string;
    newspaper?: string;
    subject?: string;
    date_from?: string;
    date_to?: string;
  },
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
    country: args.country ?? null,
    newspaper: args.newspaper ?? null,
    subject: args.subject ?? null,
    date_from: args.date_from ?? null,
    date_to: args.date_to ?? null,
  };

  const dates = validateDateBounds(args.date_from, args.date_to);
  if (dates.err) return { where, params, echo, err: dates.err };

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

  keywordFilter(schema, where, params, TEXT_COLS[subset], args.keyword);
  pipeValueFilterIfExists(schema, where, params, "country", args.country);
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
  };
}
