import type { Subset } from "../../config.js";
import { query } from "../../db.js";
import type { Selection } from "../../selection.js";
import type { ComparisonPayload } from "../../viewContract.js";
import { aggregateFilters } from "../aggregates/shared.js";
import { dateInterval } from "../shared/filters.js";

const predicate = (where: string[]) => where.length ? where.join(" AND ") : "TRUE";
const dates = (selection: Selection): Selection => ({
  date_from: selection.date_from, date_to: selection.date_to,
  hijri_month: selection.hijri_month, hijri_year: selection.hijri_year,
});

/** Both cohorts share the corpus denominator within their combined date scope. */
export async function comparisonTimeline(subset: Subset, schema: Set<string>, view: string, a: Selection, b: Selection): Promise<ComparisonPayload["temporal"]> {
  if (!schema.has("pub_date")) return undefined;
  const fa = aggregateFilters(subset, schema, a), fb = aggregateFilters(subset, schema, b);
  const da = aggregateFilters(subset, schema, dates(a)), db = aggregateFilters(subset, schema, dates(b));
  for (const filter of [fa, fb, da, db]) if (filter.err) throw new Error(filter.err.error);
  const interval = dateInterval();
  const rows = await query(`WITH dated AS (
    SELECT *, (${interval.start}) AS _iwac_compare_date_start, (${interval.end}) AS _iwac_compare_date_end FROM ${view}
  ) SELECT CASE WHEN NULLIF(TRIM(CAST(pub_date AS VARCHAR)), '') IS NULL THEN '(undated)'
    WHEN _iwac_compare_date_start IS NULL OR _iwac_compare_date_end IS NULL OR _iwac_compare_date_start > _iwac_compare_date_end THEN '(invalid date)'
    WHEN year(_iwac_compare_date_start) <> year(_iwac_compare_date_end) THEN '(multiyear)'
    ELSE strftime(_iwac_compare_date_start, '%Y') END AS year,
    COUNT(*) AS denominator,
    COUNT(*) FILTER (WHERE ${predicate(fa.where)}) AS a,
    COUNT(*) FILTER (WHERE ${predicate(fb.where)}) AS b
    FROM dated WHERE (${predicate(da.where)}) OR (${predicate(db.where)})
    GROUP BY 1 ORDER BY denominator DESC, year`, [...fa.params, ...fb.params, ...da.params, ...db.params]);
  const kept = rows.slice(0, 200).sort((x, y) => String(x.year).localeCompare(String(y.year)));
  return {
    rows: kept.flatMap((row) => (["a", "b"] as const).map((key) => ({
      year: String(row.year), selection: key.toUpperCase(), count: Number(row[key]),
      denominator: Number(row.denominator), share: Number(row[key]) / Number(row.denominator),
    }))),
    normalize_by: "corpus", omitted_years: Math.max(0, rows.length - kept.length),
    note: "Denominator is all archived items in this subset/year within the union of A and B's Gregorian/Hijri date scopes, before country, outlet or thematic filters. Both selections use that common denominator. Partial dates stay at their stored precision; missing dates, invalid dates and multiyear intervals have separate buckets. Largest 200 corpus buckets shown, sorted by year. Shares describe holdings, not historical prevalence; selections may overlap.",
  };
}
