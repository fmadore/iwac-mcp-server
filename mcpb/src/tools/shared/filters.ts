import { q, type Bindable } from "../../db.js";

// -----------------------------------------------------------------------------
// WHERE-clause helpers (all matching is accent- and case-insensitive)
// -----------------------------------------------------------------------------

// TEXT_COLS — the free-text columns each subset's keyword search matches — is
// derived from the SUBSET_FIELDS descriptor below (fields tagged `searchable`).

/**
 * Append the standard keyword predicate — ONE literal substring, OR-ed across
 * the subset's text columns (those present in this dataset revision), accent-
 * and case-insensitive. This is the single-substring semantics documented on
 * every search_* tool ("one term per call"); the unified `search` tokenizes
 * instead.
 */
export function keywordFilter(
  schema: Set<string>,
  where: string[],
  params: Bindable[],
  cols: readonly string[],
  keyword: string | undefined,
): void {
  if (!keyword) return;
  const parts: string[] = [];
  for (const col of cols) {
    if (schema.has(col)) {
      parts.push(foldedLike(q(col)));
      params.push(`%${escapeLike(keyword)}%`);
    }
  }
  if (parts.length) where.push(`(${parts.join(" OR ")})`);
}

/**
 * Escape LIKE metacharacters in a user-supplied substring so `%`, `_`, and `\`
 * match literally inside the `%...%` pattern. Without this, `keyword="100%"`
 * matches "100" followed by anything and a stray `_` matches any character —
 * silently distorted match counts, which matter when counts feed historical
 * claims. Pairs with the `ESCAPE '\'` clause in foldedLike.
 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Accent/case-insensitive substring predicate. ILIKE alone is accent-SENSITIVE:
 * `pelerinage` matches 27 articles while `pèlerinage` matches 1,816, and the
 * dataset mixes conventions ("Benin" unaccented vs "Côte d'Ivoire" accented).
 * Folding both sides through strip_accents(lower()) removes that trap class.
 * Patterns bound to this predicate must go through escapeLike().
 */
export function foldedLike(colExpr: string): string {
  return `strip_accents(lower(${colExpr})) LIKE strip_accents(lower(?)) ESCAPE '\\'`;
}

/** Accent/case-insensitive equality predicate (whole-value match). */
export function foldedEquals(colExpr: string): string {
  return `strip_accents(lower(trim(${colExpr}))) = strip_accents(lower(trim(?)))`;
}

/** Append an accent-insensitive `col LIKE %value%` to a WHERE list, if the column exists. */
export function likeFilterIfExists(
  schema: Set<string>,
  where: string[],
  params: Bindable[],
  column: string,
  value: string | undefined,
): void {
  if (!value || !schema.has(column)) return;
  where.push(foldedLike(q(column)));
  params.push(`%${escapeLike(value)}%`);
}

/**
 * Pipe-separated field filter: exact match against one `|`-split segment,
 * accent/case-folded. Use for controlled multi-value fields such as country,
 * subject, spatial, language, countries, and `Titre alternatif`. A substring
 * predicate would make `Mosquée` match `Construction mosquée`, or `state` match
 * `Islamic State in the Greater Sahara`, which turns curated filters into noisy
 * keyword searches — and, for country specifically, would conflate Niger with
 * Nigeria (references store "Niger|Nigeria", and audiovisual now spans Burkina
 * Faso, Togo, Benin and Nigeria, so both sides of that pair carry rows).
 * Single-valued columns like `articles.country` behave identically, which is why
 * country needs no predicate of its own.
 */
export function pipeValueFilterIfExists(
  schema: Set<string>,
  where: string[],
  params: Bindable[],
  column: string,
  value: string | undefined,
): void {
  if (!value || !schema.has(column)) return;
  where.push(pipeValueEquals(q(column)));
  params.push(value);
}

export function pipeValueEquals(colExpr: string): string {
  return (
    `list_contains(list_transform(str_split(coalesce(${colExpr}, ''), '|'), ` +
    `x -> strip_accents(lower(trim(x)))), strip_accents(lower(trim(?))))`
  );
}

/** First 4-digit run of a date-ish string ("2015", "2015-06-01") as a year int. */
function parseYear(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = v.trim().match(/\d{4}/);
  return m ? Number(m[0]) : undefined;
}

/**
 * Year-granularity date range on a VARCHAR `pub_date` column (references &
 * publications store it as a string, often a bare year like "1912"). Compares the
 * leading 4-digit year numerically, so it works for both "YYYY" and "YYYY-MM-DD"
 * and ignores empty/garbage values.
 */
export function yearRangeFilter(
  schema: Set<string>,
  where: string[],
  params: Bindable[],
  dateFrom: string | undefined,
  dateTo: string | undefined,
  column = "pub_date",
): void {
  if (!schema.has(column)) return;
  const yearExpr = `TRY_CAST(substr(${q(column)}, 1, 4) AS INTEGER)`;
  const fy = parseYear(dateFrom);
  const ty = parseYear(dateTo);
  if (fy !== undefined) {
    where.push(`${yearExpr} >= ?`);
    params.push(fy);
  }
  if (ty !== undefined) {
    where.push(`${yearExpr} <= ?`);
    params.push(ty);
  }
}

/**
 * Pad a partial date bound ("1995", "1995-06") to a full YYYY-MM-DD day.
 *
 * Three-way result: `undefined` = no bound given, `null` = given but
 * unparseable, string = usable. The null case exists so callers can REJECT a
 * bad bound — see `validateDateBounds`.
 */
export function normalizeDateBound(v: string | undefined, kind: "from" | "to"): string | undefined | null {
  if (!v?.trim()) return undefined;
  const m = v
    .trim()
    .match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/);
  if (!m) return null;
  if (/[T ]/.test(v.trim()) && (!m[3] || !Number.isFinite(Date.parse(v.trim())))) return null;
  const pad = (s: string) => s.padStart(2, "0");
  const mo = m[2] ? pad(m[2]) : kind === "from" ? "01" : "12";
  const year = Number(m[1]);
  const days = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  const last = days[Number(mo) - 1];
  const d = m[3] ? pad(m[3]) : kind === "from" ? "01" : String(last);
  // An out-of-range month or day would compare lexicographically against real
  // dates and quietly select the wrong rows, so it is a bad bound, not a bound.
  if (year < 1 || !last || Number(d) < 1 || Number(d) > last) return null;
  return `${m[1]}-${mo}-${d}`;
}

export interface DateValidation {
  err?: { error: string; valid_format: string };
}

/**
 * Reject unparseable `date_from` / `date_to` instead of dropping them.
 *
 * Dropping was the old behaviour and it was the dangerous kind of wrong: a
 * typo'd bound widened the query to the WHOLE corpus while the payload's
 * `filters` still echoed the bad value back, so the answer read as filtered to
 * anything consuming it. An enum typo has always failed loudly with
 * `valid_values`; dates now fail the same way.
 *
 * Callers run this BEFORE building filters, so both the day-granularity
 * (`dateRangeFilter`) and year-granularity (`yearRangeFilter`) paths are
 * covered by one check and cannot disagree about what parses.
 */
export function validateDateBounds(dateFrom?: string, dateTo?: string): DateValidation {
  for (const [field, raw, kind] of [
    ["date_from", dateFrom, "from"],
    ["date_to", dateTo, "to"],
  ] as const) {
    if (normalizeDateBound(raw, kind) === null) {
      return {
        err: {
          error: `Invalid ${field}: ${raw}`,
          valid_format: "YYYY, YYYY-MM or YYYY-MM-DD (a full ISO timestamp is also accepted)",
        },
      };
    }
  }
  const from = normalizeDateBound(dateFrom, "from");
  const to = normalizeDateBound(dateTo, "to");
  if (from && to && from > to)
    return { err: { error: "date_from is after date_to", valid_format: "An inclusive chronological interval" } };
  return {};
}

/** Parse one ISO source-date component without assigning false precision. */
function datePartBounds(raw: string): { start: string; end: string } {
  const validDay = `(regexp_full_match(${raw}, '[0-9]{4}-[0-9]{2}-[0-9]{2}') OR
    (regexp_full_match(${raw}, '[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})?')
      AND TRY_CAST(${raw} AS TIMESTAMP) IS NOT NULL))`;
  const start = `CASE WHEN substr(${raw}, 1, 4) = '0000' THEN NULL
    WHEN regexp_full_match(${raw}, '[0-9]{4}') THEN TRY_CAST(${raw} || '-01-01' AS DATE)
    WHEN regexp_full_match(${raw}, '[0-9]{4}-[0-9]{2}') THEN TRY_CAST(${raw} || '-01' AS DATE)
    WHEN ${validDay} THEN TRY_CAST(substr(${raw}, 1, 10) AS DATE) END`;
  const end = `CASE WHEN substr(${raw}, 1, 4) = '0000' THEN NULL
    WHEN regexp_full_match(${raw}, '[0-9]{4}') THEN TRY_CAST(${raw} || '-12-31' AS DATE)
    WHEN regexp_full_match(${raw}, '[0-9]{4}-[0-9]{2}') THEN last_day(TRY_CAST(${raw} || '-01' AS DATE))
    ELSE (${start}) END`;
  return { start, end };
}

/** Partial source dates and slash-separated ranges denote inclusive intervals.
 * Invalid or reversed intervals are excluded by callers; a year never acquires
 * the precision of a day simply because a date filter was requested. */
export function dateInterval(column = "pub_date"): { start: string; end: string } {
  const raw = `trim(CAST(${q(column)} AS VARCHAR))`;
  const single = datePartBounds(raw);
  const first = datePartBounds(`trim(split_part(${raw}, '/', 1))`);
  const last = datePartBounds(`trim(split_part(${raw}, '/', 2))`);
  const isRange = `len(string_split(${raw}, '/')) = 2`;
  return {
    start: `CASE WHEN ${isRange} THEN (${first.start}) ELSE (${single.start}) END`,
    end: `CASE WHEN ${isRange} THEN (${last.end}) ELSE (${single.end}) END`,
  };
}

/**
 * Day-granularity date range for `articles.pub_date`. The column's *type* has
 * changed across dataset revisions (TIMESTAMPTZ → VARCHAR), and a bare
 * `pub_date >= CAST(? AS TIMESTAMPTZ)` throws a Binder Error on the VARCHAR
 * revision. Parse each value into a calendar interval and test overlap; this
 * includes year/month-only records without pretending their precision is a day.
 */
export function dateRangeFilter(
  schema: Set<string>,
  where: string[],
  params: Bindable[],
  dateFrom: string | undefined,
  dateTo: string | undefined,
  column = "pub_date",
): void {
  if (!schema.has(column)) return;
  const interval = dateInterval(column);
  const from = normalizeDateBound(dateFrom, "from");
  const to = normalizeDateBound(dateTo, "to");
  if (from || to) where.push(`(${interval.start}) <= (${interval.end})`);
  if (from) {
    where.push(`(${interval.end}) >= CAST(? AS DATE)`);
    params.push(from);
  }
  if (to) {
    where.push(`(${interval.start}) <= CAST(? AS DATE)`);
    params.push(to);
  }
}

// -----------------------------------------------------------------------------
// Reusable ORDER BY fragments
// -----------------------------------------------------------------------------

/** Newest-first ordering used by every date-bearing subset (empty if no pub_date). */
export function pubDateOrder(schema: Set<string>): string {
  return schema.has("pub_date") ? `ORDER BY pub_date DESC NULLS LAST, "o:id"` : "";
}

/** Frequency-first ordering used by the index list/search tools. */
export function indexFreqOrder(schema: Set<string>): string {
  return schema.has("frequency") ? `ORDER BY frequency DESC NULLS LAST, ${q("Titre")}` : `ORDER BY ${q("Titre")}`;
}
