// Cross-cutting helpers shared by every tool module: input capping, JSON result
// formatting, the pagination envelope, the generic list-query runner, reusable
// ORDER-BY fragments, accent-insensitive matching, and text capping — plus
// SUBSET_FIELDS, the per-subset column descriptor every SELECT list is built
// from (see `colsFor`).
import { z } from "zod";
import {
  q,
  query,
  queryScalarSingle,
  selectList,
  viewName,
  type Bindable,
  type Row,
} from "../db.js";
import { ALL_SUBSETS, type Subset } from "../config.js";
import { VIEW_DATA_META_KEY } from "../viewContract.js";

/** The McpServer type, aliased once so tool modules don't repeat the import path. */
export type Server = import("@modelcontextprotocol/server").McpServer;

/** Maximum length of any single free-text field returned to the model. */
export const CHARACTER_LIMIT = 25000;

// -----------------------------------------------------------------------------
// Tool result / annotation helpers
// -----------------------------------------------------------------------------

export function annotate(title: string) {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

/**
 * Standard registerTool metadata: a top-level `title` (what current clients
 * display) plus the read-only annotation set (which older clients read the
 * title from). Spread into every tool's config.
 */
export function toolMeta(title: string): { title: string; annotations: ReturnType<typeof annotate> } {
  return { title, annotations: annotate(title) };
}

function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  return value;
}

/**
 * Characters that must never reach the model: C0 control codes and DEL (except
 * tab/newline/carriage-return, which are legitimate in OCR text) plus every
 * Unicode Private-Use Area code point (BMP U+E000–U+F8FF and the two
 * supplementary planes). The dataset and this server's code are clean today, but
 * a stray private-use "sentinel" leaking into a field — e.g. `ite⟨U+E000⟩m` in a
 * `url` — silently breaks links, so the server scrubs its own output instead of
 * trusting every future dataset revision or upstream pipeline step.
 */
const STRIP_CHARS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is this regex's entire purpose (see doc comment above)
  /[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu;

function sanitizeString(s: string): string {
  return s.replace(STRIP_CHARS, "");
}

/**
 * Drop null/undefined and empty-string values recursively, and scrub stray
 * control/private-use characters from every string. The parquet encodes missing
 * values as "" rather than NULL, so result rows would otherwise carry dozens of
 * `"author": ""` entries — pure token waste for the model. BIGINTs (DuckDB
 * COUNT/aggregate results) become plain numbers so the compacted value is safe
 * to ship as `structuredContent` (the transport JSON.stringifies it without a
 * replacer).
 */
function compactValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(compactValue);
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined) continue;
      if (typeof v === "string" && v.trim().length === 0) continue;
      out[k] = compactValue(v);
    }
    return out;
  }
  return value;
}

/** Compact (un-indented, empty-stripped) JSON — models parse it fine and it
 * saves ~20% of the tokens of a pretty-printed envelope. */
export function textResult(payload: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(compactValue(payload), bigintReplacer) }],
  };
}

/**
 * Like `textResult`, but ALSO returns the compacted payload as
 * `structuredContent` (same value, so the text block mirrors it exactly, per
 * the MCP back-compat rule). Use ONLY on tools that declare an `outputSchema`:
 * once declared, the SDK REQUIRES structuredContent on every non-error result.
 * Kept opt-in rather than folded into textResult because the duplicate JSON
 * doubles the wire payload — acceptable for small structured envelopes
 * (search/fetch, stats), waste for 25k-char OCR responses.
 */
export function structuredResult(payload: unknown): {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
} {
  const compacted = compactValue(payload) as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(compacted, bigintReplacer) }],
    structuredContent: compacted,
  };
}

/**
 * Like `structuredResult`, but splits the payload in two: what the MODEL reads
 * and what only the CHART reads.
 *
 * The model half goes out as `content` + `structuredContent` exactly as before.
 * The view half rides in `_meta` under {@link VIEW_DATA_META_KEY}, which MCP
 * Apps forwards to the iframe untouched but no host puts in the model's
 * context. `src/app/charts.ts` merges the two back into one flat object before
 * dispatching to a view, so views are unaware of the split.
 *
 * Use this ONLY where the view half is redundant for reasoning (scatter
 * coordinates, a per-year-per-topic matrix) and the model half still answers
 * the question on its own. A host with no MCP Apps support renders no chart at
 * all, so anything moved here is invisible to that user; moving the actual
 * answer would be a silent regression for them, not an optimisation. See
 * src/viewContract.ts.
 */
export function viewResult(
  payload: unknown,
  viewData: Record<string, unknown>,
): {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  _meta: Record<string, unknown>;
} {
  const compacted = compactValue(payload) as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(compacted, bigintReplacer) }],
    structuredContent: compacted,
    _meta: { [VIEW_DATA_META_KEY]: compactValue(viewData) },
  };
}

/**
 * Like `textResult`, but marks the result as a tool-level error (`isError: true`)
 * per MCP guidance, so the model recognises the failure and can self-correct
 * (e.g. a missing id, semantic search disabled) rather than treating the error
 * JSON as a successful result. Reserve this for genuine failures — an empty or
 * "no matches" result is a successful call and should use `textResult`.
 */
export function errorResult(payload: unknown): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  return { content: textResult(payload).content, isError: true };
}

// -----------------------------------------------------------------------------
// Input capping (lenient clamp, not rejection)
// -----------------------------------------------------------------------------

export function capLimit(v: number | undefined, def: number, max: number): number {
  return Math.max(1, Math.min(v ?? def, max));
}

export function capOffset(v: number | undefined): number {
  return Math.max(0, v ?? 0);
}

/**
 * A limit clamped to [1, max] that REMEMBERS the original request, so a tool can
 * surface a visible cap (`requested_limit` + `limit_warning`) instead of silently
 * truncating. A list that quietly returns 200 of the 500 rows asked for reads as
 * "that's all there is" — the opposite of what happened.
 *
 * `capped` covers BOTH bounds. The low end matters as much as the high one:
 * `limit: 0` used to return exactly one row with nothing saying why, which reads
 * as "the collection holds one match" — the same silent-truncation trap in
 * miniature.
 */
export interface ResolvedLimit {
  value: number;
  requested: number | undefined;
  capped: boolean;
  max: number;
  /** Why this call's maximum is lower than the tool's documented one, when it
   * is. Without it, a caller who asked for 100 and got 25 has no way to tell a
   * per-call cap from a typo in the docs. */
  reason?: string;
}

export function resolveLimit(v: number | undefined, def: number, max: number, reason?: string): ResolvedLimit {
  const value = Math.max(1, Math.min(v ?? def, max));
  return { value, requested: v, capped: v !== undefined && v !== value, max, reason };
}

/** The visible-cap fields (`requested_limit` + `limit_warning`) for a clamped
 * limit, or {} when nothing was clamped. Single source of the warning wording. */
export function limitWarning(limit: ResolvedLimit): Record<string, unknown> {
  if (!limit.capped || limit.requested === undefined) return {};
  const requested = limit.requested;
  return {
    requested_limit: requested,
    limit_warning:
      requested > limit.max
        ? `Requested limit ${requested} exceeds the maximum ${limit.max}; applied ${limit.value}.${limit.reason ? ` ${limit.reason}` : ""}`
        : `Requested limit ${requested} is below the minimum 1; applied ${limit.value}.`,
  };
}

// -----------------------------------------------------------------------------
// Closed-vocabulary filter validation
// -----------------------------------------------------------------------------
//
// Enumerated filters (country, sentiment, index type) are validated up front so
// an invalid value returns an explicit, self-correctable error instead of a
// silent zero-result. Silent zero is genuinely dangerous for research: a typo'd
// `country=Atlantis` looks identical to a real historical absence. Open free-text
// filters (newspaper, subject, author, reference_type, language) are deliberately
// NOT validated here — reference_type is a substring match ("Livre" intentionally
// also matches "Chapitre de livre") and language is an open multi-value field, so
// rejecting "unknown" values there would reject legitimate queries.

/** Canonical country names (HF storage form). Accents/case optional on input. */
export const COUNTRIES = ["Benin", "Burkina Faso", "Côte d'Ivoire", "Niger", "Nigeria", "Togo"] as const;

/**
 * Audiovisual `medium` values (closed vocabulary in the dataset).
 *
 * These are CARRIER media, not modalities: "audio"/"video" were taken from the
 * synthetic fixture rather than measured, and matched nothing in the real
 * subset — every `medium` filter a caller could pass validation with returned
 * zero rows, which is exactly the silent absence validateEnum exists to
 * prevent. Measured against the 2026-08-17 revision: Vidéo sur le web 1,724,
 * DVD 43, CD 1, empty 3.
 */
export const MEDIUM_VALUES = ["Vidéo sur le web", "DVD", "CD"] as const;

/**
 * The standard `country` filter parameter, built once so the ~12 tools that take
 * it share ONE wording instead of copy-paste drift. `nigeria: false` (the
 * default for article-backed tools) omits Nigeria from the enumerated values —
 * Nigeria has no press articles, so advertising it there invites dead-end
 * queries; validateEnum still accepts it (a valid country with 0 rows is a real
 * absence, not an error). `note` appends tool-specific context.
 */
export function countryParam(opts: { nigeria?: boolean; note?: string } = {}) {
  const values = ["Benin", "Burkina Faso", "Côte d'Ivoire", "Niger"]
    .concat(opts.nigeria ? ["Nigeria"] : [])
    .concat(["Togo"])
    .join(" | ");
  return z
    .string()
    .optional()
    .describe(`Exact country name: ${values} (accents optional)${opts.note ? `. ${opts.note}` : ""}`);
}

/** AI polarity labels (articles); same six-point scale for all three models. */
export const POLARITY_VALUES = ["Très positif", "Positif", "Neutre", "Négatif", "Très négatif", "Non applicable"] as const;

/** AI centrality labels (articles); same five-point scale for all three models. */
export const CENTRALITY_VALUES = ["Très central", "Central", "Secondaire", "Marginal", "Non abordé"] as const;

/**
 * AI subjectivity labels, least to most subjective. Generation 2 stores this as
 * an ORDINAL LABEL; generation 1 stored a 1-5 float. The dataset column is still
 * named `…_subjectivite_score`, so the name gives no warning that its type
 * changed — only the values do. Order is load-bearing: it is the rank mapping
 * behind `mean_rank`/`median_rank` and the chart's scale order.
 */
export const SUBJECTIVITY_VALUES = [
  "Très objectif",
  "Plutôt objectif",
  "Mixte",
  "Plutôt subjectif",
  "Très subjectif",
] as const;

/** Rank 1-5 for a stored subjectivity label, or undefined for anything else. */
export function subjectivityRank(label: string): number | undefined {
  const i = SUBJECTIVITY_VALUES.indexOf(label.trim() as (typeof SUBJECTIVITY_VALUES)[number]);
  return i < 0 ? undefined : i + 1;
}

// -----------------------------------------------------------------------------
// AI sentiment models
// -----------------------------------------------------------------------------

export interface SentimentModel {
  /** Canonical id — the exact model that produced the scores. */
  id: string;
  /** Dataset column prefix: `<prefix>_polarite`, `<prefix>_centralite_islam_musulmans`, … */
  prefix: string;
  /** Vendor shorthand also accepted on input. */
  aliases: string[];
}

/**
 * The three models of the generation-2 annotation campaign, each covering the
 * 12,305 French- and English-language articles (the 51 Ewé/Kabiyè/Dendi/untagged
 * ones are skipped deliberately: the prompt is French, and a French-prompted
 * model returns confident but unusable output for them).
 *
 * Generation 1 (`gemini-3-flash-preview`, `gpt-5-mini`, `ministral-14b-2512`) is
 * NOT served here. Its columns still exist on the Hub, but the archive's own
 * annotations were emptied on 2026-08-07 and the two generations differ in
 * model, prompt AND subjectivity dtype — so mixing them in one vocabulary would
 * put three-way comparisons one typo away from confounding all three. Retired
 * handles get a named error instead; see RETIRED_SENTIMENT_MODELS.
 *
 * Only vendor shorthand is aliased. A retired EXACT model id is never remapped
 * onto its vendor's successor: `gpt-5-mini` and `gpt-5-6-luna` disagree, and
 * quietly answering with the wrong one is the ambiguity this registry exists to
 * prevent.
 */
export const SENTIMENT_MODELS: SentimentModel[] = [
  { id: "gpt-5-6-luna", prefix: "gpt_5_6_luna", aliases: ["chatgpt", "openai", "gpt", "luna"] },
  { id: "mistral-small-2603", prefix: "mistral_small_2603", aliases: ["mistral"] },
  { id: "deepseek-v4-flash-0731", prefix: "deepseek_v4_flash_0731", aliases: ["deepseek"] },
];

/**
 * Handles that named a real annotator once and must not be silently re-pointed.
 * Generation 1's three ids, plus the vendor shorthands with no generation-2
 * successor (`gemini` — the Gemini slot ran in generation 1 only, and
 * `ministral`, a distinct Mistral product line from Mistral Small).
 */
export const RETIRED_SENTIMENT_MODELS: Record<string, string> = {
  "gemini-3-flash-preview": "generation 1, dropped from this server",
  "gpt-5-mini": "generation 1, dropped from this server",
  "ministral-14b-2512": "generation 1, dropped from this server",
  gemini: "the Gemini slot scored the corpus in generation 1 only; generation 2 has no Gemini member",
  google: "the Gemini slot scored the corpus in generation 1 only; generation 2 has no Gemini member",
  ministral: "Ministral 14B is generation 1; Mistral Small 2603 is a different model, ask for it by name",
};

/**
 * The model reported by the single-model surfaces: the `polarity`/`centrality`/
 * `subjectivity` columns on article rows, search_by_sentiment's filters, and
 * get_country_comparison. Those name it explicitly rather than implying a
 * consensus — get_sentiment_distribution with model:"all" is the tool for that.
 *
 * gpt-5-6-luna and not one of the other two: it is complete on all three fields
 * (its only subjectivity gaps are exactly its `Non abordé` rows, a principled
 * abstention rather than a dropped answer), where deepseek-v4-flash-0731 omits
 * ~489 scores it owed; and the Mistral family is a persistent outlier on
 * centrality (κ 0.244-0.270 pairwise against 0.511-0.725 for the others), which
 * is a bad thing for a default to make invisible.
 */
export const DEFAULT_SENTIMENT_MODEL: SentimentModel = SENTIMENT_MODELS[0];

/** Canonical ids, for `valid_values` in an error and for tool descriptions. */
export const SENTIMENT_MODEL_IDS: string[] = SENTIMENT_MODELS.map((m) => m.id);

/** The three scored columns of one model. */
export function sentimentCols(m: SentimentModel): {
  polarity: string;
  centrality: string;
  subjectivity: string;
} {
  return {
    polarity: `${m.prefix}_polarite`,
    centrality: `${m.prefix}_centralite_islam_musulmans`,
    subjectivity: `${m.prefix}_subjectivite_score`,
  };
}

/** Normalise a model handle: case, whitespace and `_`/`-` are interchangeable. */
function sentimentKey(input: string): string {
  return input.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

/**
 * Resolve a caller's model handle to its registry entry, accepting the canonical
 * id, a vendor alias, or the raw column prefix (`_` and `-` are interchangeable,
 * so `gpt_5_6_luna` and `gpt-5-6-luna` both land on the same model).
 */
export function resolveSentimentModel(input: string): SentimentModel | undefined {
  const key = sentimentKey(input);
  return SENTIMENT_MODELS.find((m) => m.id === key || m.aliases.includes(key));
}

/** Why a retired handle is refused, or undefined if it was never one. */
export function retiredSentimentModel(input: string): string | undefined {
  return RETIRED_SENTIMENT_MODELS[sentimentKey(input)];
}

/** Authority-index `Type` values. */
export const INDEX_TYPES = ["Personnes", "Organisations", "Lieux", "Événements", "Sujets", "Notices d'autorité"] as const;

export interface EnumValidation {
  /** Canonical spelling when the input matched (undefined when no value was given). */
  canonical?: string;
  /** An `{error, valid_values}` payload to wrap in errorResult when the input is invalid. */
  err?: { error: string; valid_values: string[] };
}

/**
 * Validate a closed-vocabulary filter accent/case-insensitively. Returns the
 * canonical spelling on a match (so the SQL filter uses the dataset's exact
 * value), an `{error, valid_values}` payload on a miss, or an empty object when
 * no value was supplied (the filter is simply skipped). Folding mirrors the
 * SQL-side strip_accents(lower()) via foldText, so `cote d'ivoire` ≡ `Côte d'Ivoire`.
 */
export function validateEnum(
  value: string | undefined,
  vocab: readonly string[],
  field: string,
): EnumValidation {
  if (value === undefined || value.trim() === "") return {};
  const folded = foldText(value).trim();
  const match = vocab.find((v) => foldText(v).trim() === folded);
  if (match) return { canonical: match };
  return { err: { error: `Invalid ${field}: ${value}`, valid_values: [...vocab] } };
}

// -----------------------------------------------------------------------------
// Hijri (Umm al-Qura) calendar
// -----------------------------------------------------------------------------

/**
 * Lunar month names, index 0 = Muharram.
 *
 * These are the ACADEMIC transliterations the IWAC website uses (the same table
 * as IwacVisualizations' `asset/js/charts/shared/hijri.js`), so a reader moving
 * between a chart there and a result here meets one spelling.
 */
export const HIJRI_MONTHS = [
  "Muharram", "Safar", "Rabi' I", "Rabi' II",
  "Jumada I", "Jumada II", "Rajab", "Sha'ban",
  "Ramadan", "Shawwal", "Dhu al-Qa'da", "Dhu al-Hijja",
] as const;

/**
 * French forms, accepted on input only. The collection's press is ~96 %
 * francophone and the INSTRUCTIONS tell the model to query in French, so
 * refusing "Ramadan"/"Chaabane"/"Dhou al-hijja" would be refusing the spelling
 * this server itself asks for. Output always uses HIJRI_MONTHS.
 */
const HIJRI_MONTHS_FR = [
  "Mouharram", "Safar", "Rabia I", "Rabia II",
  "Joumada I", "Joumada II", "Rajab", "Chaabane",
  "Ramadan", "Chawwal", "Dhou al-qi'da", "Dhou al-hijja",
] as const;

/** Common alternates that are neither table's canonical form. */
const HIJRI_MONTH_ALIASES: Record<string, number> = {
  // Anglophone spellings a non-francophone user will reach for first.
  "rabi al-awwal": 3, "rabi i": 3, "rabi 1": 3,
  "rabi al-thani": 4, "rabi ii": 4, "rabi 2": 4,
  "jumada al-awwal": 5, "jumada 1": 5,
  "jumada al-thani": 6, "jumada 2": 6,
  shaaban: 8, shaban: 8, chaban: 8,
  ramadhan: 9, ramzan: 9,
  "dhul-qadah": 11, "dhu al-qada": 11, "zul-qadah": 11,
  "dhul-hijjah": 12, "dhu al-hijja": 12, "zul-hijjah": 12,
};

/**
 * Resolve a `hijri_month` argument to 1-12.
 *
 * Accepts the number as a string ("9"), either transliteration, or a common
 * alternate — all accent- and case-folded, matching the rest of this server.
 * An unrecognised value is an ERROR carrying `valid_values`, never a silent
 * zero-row filter: "Ramadam" returning 0 articles would be indistinguishable
 * from a real absence.
 */
export function resolveHijriMonth(value: string | undefined): { n?: number; err?: unknown } {
  if (value === undefined || value.trim() === "") return {};
  const raw = value.trim();
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n >= 1 && n <= 12) return { n };
    return {
      err: {
        error: `Invalid hijri_month: ${value}`,
        valid_values: [...HIJRI_MONTHS],
        note: "A lunar month is 1-12 (1 = Muharram, 9 = Ramadan, 12 = Dhu al-Hijja).",
      },
    };
  }
  const folded = foldText(raw).trim();
  const hit =
    HIJRI_MONTHS.findIndex((m) => foldText(m).trim() === folded) + 1 ||
    HIJRI_MONTHS_FR.findIndex((m) => foldText(m).trim() === folded) + 1 ||
    HIJRI_MONTH_ALIASES[folded.replace(/['’]/g, "")] ||
    0;
  if (hit) return { n: hit };
  return {
    err: {
      error: `Invalid hijri_month: ${value}`,
      valid_values: [...HIJRI_MONTHS],
      note: "French forms (Mouharram, Chaabane, Chawwal, Dhou al-hijja) and 1-12 are accepted too.",
    },
  };
}

/** The three precomputed columns, as a `requires` guard for column descriptors. */
export const HIJRI_COLS = ["hijri_year", "hijri_month", "hijri_day"];

/**
 * The lunar date as one `1440-09-15` string, mirroring how `pub_date` reads.
 * Numeric parts rather than a month name: the name would have to be a 12-branch
 * CASE in SQL that then drifts from HIJRI_MONTHS, and the model already has that
 * table from `month_labels`.
 */
export const HIJRI_DATE_EXPR =
  `CASE WHEN "hijri_year" IS NULL THEN NULL ELSE CAST("hijri_year" AS VARCHAR) || '-' || ` +
  `lpad(CAST("hijri_month" AS VARCHAR), 2, '0') || '-' || lpad(CAST("hijri_day" AS VARCHAR), 2, '0') END`;

/**
 * Guard for every Hijri-aware code path: the columns are written by the
 * pipeline (`post-processing/calculate_hijri_dates.py`), so a dataset revision
 * from before that script ran simply does not have them. Say so, rather than
 * letting the query fail with a SQL binder error the model cannot act on.
 */
export function requireHijriColumns(
  schema: Set<string>,
  subset: string,
): { error: string; note: string } | undefined {
  const missing = ["hijri_year", "hijri_month"].filter((c) => !schema.has(c));
  if (!missing.length) return undefined;
  return {
    error: `Subset '${subset}' has no Hijri date columns (${missing.join(", ")}) in this dataset revision.`,
    note:
      "Lunar dates are precomputed by the IWAC pipeline and only cover subsets whose date marks an event " +
      "in the Islamic calendar (articles, publications, documents, audiovisual, images — not references). " +
      "Use the Gregorian calendar for this subset.",
  };
}

/**
 * Append the lunar-date filters. Both columns are nullable — an item dated only
 * to a year has no lunar date — and `= ?` already excludes NULL, so an
 * imprecisely dated item is never silently counted into a month it may not
 * belong to.
 */
export function hijriFilter(
  where: string[],
  params: Bindable[],
  month: number | undefined,
  year: number | undefined,
): void {
  if (month !== undefined) {
    where.push("hijri_month = ?");
    params.push(month);
  }
  if (year !== undefined) {
    where.push("hijri_year = ?");
    params.push(year);
  }
}

// -----------------------------------------------------------------------------
// Pagination
// -----------------------------------------------------------------------------

export interface PaginationEnvelope<T> {
  count: number;
  total_matches: number;
  offset: number;
  limit: number;
  has_more: boolean;
  next_offset?: number;
  requested_limit?: number;
  limit_warning?: string;
  /** Optional semantics note a tool can attach (e.g. list_locations' mentioned-in caveat). */
  note?: string;
  results: T[];
}

export async function paginated<T>(
  countSql: string,
  countParams: Bindable[],
  pageSql: string,
  pageParams: Bindable[],
  offset: number,
  limit: ResolvedLimit,
): Promise<PaginationEnvelope<T>> {
  const total = Number((await queryScalarSingle<number | bigint>(countSql, countParams)) ?? 0);
  const results = (await query(pageSql, pageParams)) as unknown as T[];
  const hasMore = offset + limit.value < total;
  const env: PaginationEnvelope<T> = {
    count: results.length,
    total_matches: total,
    offset,
    limit: limit.value,
    has_more: hasMore,
    results,
  };
  if (hasMore) env.next_offset = offset + limit.value;
  Object.assign(env, limitWarning(limit));
  return env;
}

/**
 * Run the standard "filtered, ordered, paginated list" query shared by every
 * search/list tool: assemble the WHERE clause, run a COUNT and a page query
 * against the subset's view, and return a pagination envelope. `cols` and
 * `orderBy` are subset-specific and supplied by the caller.
 */
export async function runListQuery<T = Row>(opts: {
  subset: Subset;
  where: string[];
  params: Bindable[];
  cols: string;
  orderBy: string;
  limit: ResolvedLimit;
  offset: number;
}): Promise<PaginationEnvelope<T>> {
  const { subset, where, params, cols, orderBy, limit, offset } = opts;
  const view = viewName(subset);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const countSql = `SELECT COUNT(*) FROM ${view} ${whereSql}`;
  const pageSql = `SELECT ${cols} FROM ${view} ${whereSql} ${orderBy} LIMIT ${limit.value} OFFSET ${offset}`;
  return paginated<T>(countSql, params, pageSql, params, offset, limit);
}

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
 * Nigeria (references store "Niger|Nigeria"; audiovisual is 100% Nigeria).
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
function normalizeDateBound(v: string | undefined, kind: "from" | "to"): string | undefined | null {
  if (!v?.trim()) return undefined;
  const m = v.trim().match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
  if (!m) return null;
  const pad = (s: string) => s.padStart(2, "0");
  const mo = m[2] ? pad(m[2]) : kind === "from" ? "01" : "12";
  const d = m[3] ? pad(m[3]) : kind === "from" ? "01" : "31";
  // An out-of-range month or day would compare lexicographically against real
  // dates and quietly select the wrong rows, so it is a bad bound, not a bound.
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
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
  return {};
}

/**
 * Day-granularity date range for `articles.pub_date`. The column's *type* has
 * changed across dataset revisions (TIMESTAMPTZ → VARCHAR), and a bare
 * `pub_date >= CAST(? AS TIMESTAMPTZ)` throws a Binder Error on the VARCHAR
 * revision. Casting the column to VARCHAR and comparing the ISO YYYY-MM-DD
 * prefix lexicographically works for both revisions and tolerates partial
 * ("1995-06") and empty values.
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
  const dayExpr = `NULLIF(substr(CAST(${q(column)} AS VARCHAR), 1, 10), '')`;
  const from = normalizeDateBound(dateFrom, "from");
  const to = normalizeDateBound(dateTo, "to");
  if (from) {
    where.push(`${dayExpr} >= ?`);
    params.push(from);
  }
  if (to) {
    where.push(`${dayExpr} <= ?`);
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
  return schema.has("frequency")
    ? `ORDER BY frequency DESC NULLS LAST, ${q("Titre")}`
    : `ORDER BY ${q("Titre")}`;
}

// -----------------------------------------------------------------------------
// Per-subset field descriptor — the ONE place that maps dataset columns to the
// stable output keys, for EVERY projection.
//
// Output keys are normalised to short English snake_case across all tools so the
// model sees ONE shape (`id`, `date`, `polarity`, …) instead of re-learning
// per-tool field names — and the long French dataset keys
// (gpt_5_6_luna_centralite_islam_musulmans × 20 rows) stop costing
// tokens.
//
// Each column is declared ONCE, with its SQL expression, output alias, schema
// dependencies, and the set of VIEWS it belongs to. Previously the same column
// was restated in up to four places — a detail table, a `*SummaryCols` function,
// an inline `selectList` in a tool module, and the TEXT_COLS search surface —
// which is how the detail lists had already drifted apart before they were
// consolidated. A dataset column rename is now a single-line change everywhere.
//
// Columns absent from the live schema are dropped by selectList, so a dataset
// revision degrades gracefully instead of throwing.
// -----------------------------------------------------------------------------

/**
 * The projections a field can belong to. Most are shared; a few are specific to
 * one subset's tools, which is fine — the field tables are per-subset anyway.
 *
 *   detail   every get_* tool: the full record
 *   fetch    the lean cross-subset `fetch` (OpenAI Deep Research contract);
 *            deliberately omits verbose/lexical fields to keep deep-research
 *            payloads small, and re-aliases the body column to `text`
 *   summary  the search_* result rows
 *   triage   articles only: summary + the AI abstract (`with_description`)
 *   withToc  publications only: summary + the table of contents (the text the
 *            TOC keyword match and the semantic ranking actually ran against)
 *   list     index only: the lean list_subjects/locations/persons rows
 *   listCountries  index only: list + `countries` (the country-filtered lists)
 *   sentiment      articles only: the search_by_sentiment rows
 */
export type FieldView =
  | "detail"
  | "fetch"
  | "summary"
  | "triage"
  | "withToc"
  | "list"
  | "listCountries"
  | "sentiment";

/** Views that are "base view + a few extra columns", so the shared columns are
 * declared once on the base rather than repeated on both. */
const VIEW_BASE: Partial<Record<FieldView, FieldView>> = {
  triage: "summary",
  withToc: "summary",
  listCountries: "list",
};

interface SubsetField {
  /** SQL expression — a bare column name, or a pre-quoted/complex expression. */
  expr: string;
  /** Output alias; bare columns without one keep their own name. */
  alias?: string;
  /** Columns that must exist in the live schema (defaults to the bare column). */
  requires?: string[];
  /** The projections this column appears in. */
  views: FieldView[];
  /** The subset's main text body; `fetch` re-aliases it to the contract key `text`. */
  body?: boolean;
  /** Part of the subset's keyword-search surface (derives TEXT_COLS). */
  searchable?: boolean;
  /**
   * A full-text blob rather than a metadata field: matching it means folding and
   * scanning hundreds of MB. Measured on the July 2026 dataset, one accent-folded
   * LIKE over `publications.OCR` costs ~1.8 s and over `articles.OCR` ~0.46 s,
   * versus ~30 ms for all the curated columns of a subset combined. Derives
   * FAST_TEXT_COLS, which the unified `search` tries first (see search.ts).
   */
  heavy?: boolean;
}

/** Every subset leads with its id and canonical IWAC URL. */
const ID_URL = (views: FieldView[]): SubsetField[] => [
  { expr: '"o:id"', alias: "id", requires: ["o:id"], views },
  { expr: "iwac_url", alias: "url", requires: ["iwac_url"], views },
];

/**
 * A free-text column truncated for SEARCH ROWS, the full value being carried by
 * the same subset's detail view. Paired as two field entries — the snippet under
 * its own alias in `summary`, the whole column in `detail`/`fetch` — so a page of
 * results stays cheap without the caller losing access to the rest.
 */
const snippetExpr = (column: string, max = 320): string =>
  `CASE WHEN ${q(column)} IS NULL OR length(trim(${q(column)})) = 0 THEN NULL ` +
  `WHEN length(${q(column)}) <= ${max} THEN ${q(column)} ` +
  `ELSE substr(${q(column)}, 1, ${max}) || '…' END`;

/** Truncated abstract for reference search results (full text via get_reference). */
const ABSTRACT_SNIPPET_EXPR = snippetExpr("abstract");

const ALL_ARTICLE_VIEWS: FieldView[] = ["detail", "fetch", "summary", "sentiment"];

/**
 * The sentiment columns projected onto article rows. One model's, not a blend:
 * the three disagree often enough that averaging them here would invent a
 * reading no annotator produced. `requires` drops them on a revision that
 * predates the generation-2 columns rather than throwing. `subjectivity` is a
 * French label here, not a number — see SUBJECTIVITY_VALUES.
 */
const SENTIMENT = sentimentCols(DEFAULT_SENTIMENT_MODEL);

const SUBSET_FIELDS: Record<Subset, SubsetField[]> = {
  articles: [
    ...ID_URL(ALL_ARTICLE_VIEWS),
    { expr: "identifier", views: ["detail"] },
    { expr: "title", views: ALL_ARTICLE_VIEWS, searchable: true },
    { expr: "author", views: ["detail", "fetch", "summary"] },
    { expr: "newspaper", views: ALL_ARTICLE_VIEWS },
    { expr: "country", views: ALL_ARTICLE_VIEWS },
    { expr: "pub_date", alias: "date", requires: ["pub_date"], views: ALL_ARTICLE_VIEWS },
    // The lunar date, alongside the Gregorian one. Filtering by `hijri_month`
    // and getting back rows that show no lunar date leaves the caller unable to
    // see what matched. `requires` keeps it absent on dataset revisions from
    // before the pipeline wrote the columns, so it costs nothing until it can
    // say something.
    { expr: HIJRI_DATE_EXPR, alias: "hijri_date", requires: HIJRI_COLS, views: ALL_ARTICLE_VIEWS },
    { expr: "subject", views: ["detail", "fetch", "summary"] },
    { expr: "spatial", views: ["detail", "fetch", "summary"] },
    { expr: "language", views: ["detail", "fetch", "summary"] },
    { expr: "nb_pages", views: ["detail"] },
    // `triage` only, not `summary`: search_articles returns the ~500-char
    // abstract solely under with_description (it costs ~125 tokens/row).
    {
      expr: '"descriptionAI"',
      alias: "description_ai",
      requires: ["descriptionAI"],
      views: ["detail", "fetch", "triage"],
      searchable: true,
    },
    // The English half of the bilingual summary (the dataset splits the two
    // `@language` literals into `descriptionAI` + `descriptionAI_en` rather
    // than pipe-joining them).
    //
    // SEARCHED, NEVER RETURNED — `views: []` is deliberate, not an oversight.
    // Every response carries exactly ONE summary, the French one: the two say
    // the same thing about the same item, so returning both would roughly
    // double the ~125 tokens/row an abstract costs to tell the reader nothing
    // new. `searchable` is the load-bearing flag: without it the English text
    // sits on the Hub but is absent from TEXT_COLS, so an English query matches
    // nothing it contains — strictly worse for anglophone discovery than the
    // pipe-joined column this replaced. So: queries reach both languages,
    // payloads carry one. French is the returned one because it is the source
    // language and the only one present on every row (the 51 non-FR/EN articles
    // keep an untagged French summary and have no English counterpart).
    {
      expr: '"descriptionAI_en"',
      alias: "description_ai_en",
      requires: ["descriptionAI_en"],
      views: [],
      searchable: true,
    },
    { expr: SENTIMENT.polarity, alias: "polarity", requires: [SENTIMENT.polarity], views: ALL_ARTICLE_VIEWS },
    {
      expr: SENTIMENT.centrality,
      alias: "centrality",
      requires: [SENTIMENT.centrality],
      views: ALL_ARTICLE_VIEWS,
    },
    {
      expr: SENTIMENT.subjectivity,
      alias: "subjectivity",
      requires: [SENTIMENT.subjectivity],
      views: ["detail", "summary", "sentiment"],
    },
    { expr: "nb_mots", alias: "word_count", requires: ["nb_mots"], views: ["detail"] },
    { expr: '"Richesse_Lexicale_OCR"', alias: "lexical_richness", requires: ["Richesse_Lexicale_OCR"], views: ["detail"] },
    { expr: '"Lisibilite_OCR"', alias: "readability", requires: ["Lisibilite_OCR"], views: ["detail"] },
    { expr: '"OCR"', alias: "ocr_text", requires: ["OCR"], views: ["detail", "fetch"], body: true, searchable: true, heavy: true },
  ],

  publications: [
    ...ID_URL(["detail", "fetch", "summary"]),
    { expr: "title", views: ["detail", "fetch", "summary"], searchable: true },
    { expr: "newspaper", views: ["detail", "fetch", "summary"] },
    { expr: "country", views: ["detail", "fetch", "summary"] },
    { expr: "pub_date", alias: "date", requires: ["pub_date"], views: ["detail", "fetch", "summary"] },
    { expr: HIJRI_DATE_EXPR, alias: "hijri_date", requires: HIJRI_COLS, views: ["detail", "fetch", "summary"] },
    { expr: "subject", views: ["detail", "fetch", "summary"], searchable: true },
    { expr: "language", views: ["detail", "fetch", "summary"] },
    // Summary-only, matching the previous hand-written lists: the detail/fetch
    // projections never carried nb_pages for publications.
    { expr: "nb_pages", views: ["summary"] },
    {
      expr: '"tableOfContents"',
      alias: "table_of_contents",
      requires: ["tableOfContents"],
      views: ["detail", "fetch", "withToc"],
      searchable: true,
    },
    { expr: '"OCR"', alias: "ocr_text", requires: ["OCR"], views: ["detail", "fetch"], body: true, searchable: true, heavy: true },
  ],

  references: [
    ...ID_URL(["detail", "fetch", "summary"]),
    { expr: "identifier", views: ["detail"] },
    { expr: "title", views: ["detail", "fetch", "summary"], searchable: true },
    { expr: "author", views: ["detail", "fetch", "summary"] },
    { expr: "editor", views: ["detail", "fetch"] },
    { expr: "type", views: ["detail", "fetch", "summary"] },
    { expr: '"o:resource_class"', alias: "resource_class", requires: ["o:resource_class"], views: ["detail"] },
    { expr: "pub_date", alias: "date", requires: ["pub_date"], views: ["detail", "fetch", "summary"] },
    { expr: "publisher", views: ["detail", "fetch", "summary"] },
    { expr: "book_title", views: ["detail", "fetch"] },
    { expr: "chapter", views: ["detail"] },
    { expr: "volume", views: ["detail", "fetch"] },
    { expr: "issue", views: ["detail", "fetch"] },
    { expr: "page_start", views: ["detail", "fetch"] },
    { expr: "page_end", views: ["detail", "fetch"] },
    { expr: "nb_pages", views: ["detail"] },
    { expr: "edition", views: ["detail"] },
    { expr: "extent", views: ["detail"] },
    { expr: "subject", views: ["detail"] },
    { expr: "spatial", views: ["detail"] },
    { expr: "language", views: ["detail", "fetch", "summary"] },
    { expr: "country", views: ["detail", "fetch", "summary"] },
    { expr: "doi", views: ["detail", "fetch", "summary"] },
    { expr: '"URL"', alias: "external_url", requires: ["URL"], views: ["detail"] },
    { expr: "is_part_of", views: ["detail"] },
    { expr: "review_of", views: ["detail"] },
    { expr: "provenance", views: ["detail"] },
    { expr: ABSTRACT_SNIPPET_EXPR, alias: "abstract_snippet", requires: ["abstract"], views: ["summary"] },
    { expr: "abstract", alias: "abstract", requires: ["abstract"], views: ["detail", "fetch"], body: true, searchable: true },
  ],

  documents: [
    ...ID_URL(["detail", "fetch", "summary"]),
    { expr: "identifier", views: ["detail"] },
    { expr: "title", views: ["detail", "fetch", "summary"], searchable: true },
    { expr: "author", views: ["detail", "fetch", "summary"] },
    { expr: "country", views: ["detail", "fetch", "summary"] },
    { expr: "pub_date", alias: "date", requires: ["pub_date"], views: ["detail", "fetch", "summary"] },
    { expr: "type", views: ["detail", "fetch", "summary"] },
    { expr: "subject", views: ["detail", "fetch", "summary"], searchable: true },
    { expr: "spatial", views: ["detail"] },
    { expr: "language", views: ["detail", "fetch"] },
    { expr: "nb_pages", views: ["detail"] },
    { expr: "source", views: ["detail"] },
    { expr: "rights", views: ["detail"] },
    {
      expr: '"descriptionAI"',
      alias: "description_ai",
      requires: ["descriptionAI"],
      views: ["detail", "fetch", "summary"],
      searchable: true,
    },
    // English half of the bilingual summary — searched, never returned, so a
    // response carries one summary rather than two. See articles.descriptionAI_en.
    {
      expr: '"descriptionAI_en"',
      alias: "description_ai_en",
      requires: ["descriptionAI_en"],
      views: [],
      searchable: true,
    },
    { expr: "nb_mots", alias: "word_count", requires: ["nb_mots"], views: ["detail"] },
    { expr: '"OCR"', alias: "ocr_text", requires: ["OCR"], views: ["detail", "fetch"], body: true, searchable: true, heavy: true },
  ],

  index: [
    ...ID_URL(["detail", "fetch", "summary", "list"]),
    { expr: '"Titre"', alias: "title", requires: ["Titre"], views: ["detail", "fetch", "summary", "list"], searchable: true },
    // Pipe-separated aliases — the columns that make a search for "Dahomey"
    // resolve to "Bénin". Carried in search results only.
    {
      expr: '"Titre alternatif"',
      alias: "alternate_titles",
      requires: ["Titre alternatif"],
      views: ["summary"],
      searchable: true,
    },
    { expr: '"Type"', alias: "type", requires: ["Type"], views: ["detail", "fetch", "summary"] },
    { expr: "frequency", views: ["detail", "fetch", "summary", "list"] },
    { expr: "first_occurrence", views: ["detail", "fetch", "summary"] },
    { expr: "last_occurrence", views: ["detail", "fetch", "summary"] },
    // The uncountried lists (list_subjects) omit this; the country-filtered ones
    // return it so the caller can see WHY an entry matched.
    { expr: "countries", views: ["detail", "fetch", "summary", "listCountries"] },
    {
      expr: '"Description"',
      alias: "description",
      requires: ["Description"],
      views: ["detail", "fetch", "summary", "list"],
      body: true,
      searchable: true,
    },
  ],

  audiovisual: [
    ...ID_URL(["detail", "fetch", "summary"]),
    { expr: "identifier", views: ["detail"] },
    { expr: "added_date", views: ["detail"] },
    { expr: "iiif_manifest", views: ["detail", "fetch"] },
    { expr: "PDF", alias: "media_url", requires: ["PDF"], views: ["detail", "fetch", "summary"] },
    { expr: "thumbnail", views: ["detail", "fetch"] },
    { expr: "title", views: ["detail", "fetch", "summary"], searchable: true },
    { expr: "creator", views: ["detail", "fetch", "summary"], searchable: true },
    { expr: "publisher", views: ["detail", "fetch", "summary"], searchable: true },
    { expr: "country", views: ["detail", "fetch", "summary"] },
    { expr: "pub_date", alias: "date", requires: ["pub_date"], views: ["detail", "fetch", "summary"] },
    { expr: "volume", views: ["detail", "fetch"] },
    { expr: "issue", views: ["detail", "fetch"] },
    { expr: "is_part_of", views: ["detail", "fetch"] },
    { expr: "extent", views: ["detail", "fetch", "summary"] },
    { expr: "medium", views: ["detail", "fetch", "summary"] },
    { expr: "subject", views: ["detail", "fetch", "summary"], searchable: true },
    { expr: "spatial", views: ["detail", "fetch", "summary"], searchable: true },
    { expr: "language", views: ["detail", "fetch", "summary"], searchable: true },
    // Searchable but not projected into search rows, matching the previous
    // hand-written list — `source` is a provenance note, not a triage field.
    { expr: "source", views: ["detail", "fetch"], searchable: true },
    {
      expr: '"descriptionAI"',
      alias: "description_ai",
      requires: ["descriptionAI"],
      views: ["detail", "fetch"],
      searchable: true,
    },
    // Empty corpus-wide today (0 of 1,771), like its French counterpart —
    // carried so that populating the summaries later is a data change, not a
    // schema change. Searched, never returned. See articles.descriptionAI_en.
    {
      expr: '"descriptionAI_en"',
      alias: "description_ai_en",
      requires: ["descriptionAI_en"],
      views: [],
      searchable: true,
    },
    // The item's own blurb — a YouTube video description for the harvested rows,
    // a bilingual synopsis for the deposited ones — and for most of this subset
    // the ONLY substantive text there is: `descriptionAI` is empty for all
    // 1,771 rows and the transcription ships for 50, while `description` is
    // filled for 1,465. It was carried by neither the search surface nor any
    // view until 2026-08-17, which left the great majority of the post-harvest
    // subset reachable by title and publisher alone. Deliberately NOT `heavy`
    // (median ~205 characters): it belongs in the fast pass, so the unified
    // `search` finds these videos without falling through to the OCR scan.
    { expr: snippetExpr("description"), alias: "description_snippet", requires: ["description"], views: ["summary"] },
    { expr: "description", views: ["detail", "fetch"], searchable: true },
    // The transcription column, added to the dataset in July 2026. It is the
    // ONLY real text this subset has: `descriptionAI` is still empty for all
    // 1,771 rows, so leaving it as the body made every `fetch` on an audiovisual
    // item answer "(no full text available)" while the transcriptions sat
    // unread. Public for 50 rows after the 2026-08-17 harvest (OCR_is_public).
    {
      expr: '"OCR"',
      alias: "transcription",
      requires: ["OCR"],
      views: ["detail", "fetch"],
      body: true,
      searchable: true,
      heavy: true,
    },
  ],

  // Photographs (July 2026). No OCR and no long text at all — `description` is
  // the body, filled for 2 of 30 rows — so every column here is cheap to match.
  // `embedding_image` is multimodal (the photo itself embedded into the same
  // 768-dim space as the text vectors), which is what lets a French text query
  // retrieve a photograph in semantic_search_images.
  images: [
    ...ID_URL(["detail", "fetch", "summary"]),
    { expr: "identifier", views: ["detail"] },
    { expr: "added_date", views: ["detail"] },
    { expr: "image_url", views: ["detail", "fetch", "summary"] },
    { expr: "thumbnail", views: ["detail", "fetch"] },
    { expr: "iiif_manifest", views: ["detail", "fetch"] },
    { expr: "title", views: ["detail", "fetch", "summary"], searchable: true },
    { expr: "type", views: ["detail"] },
    { expr: "creator", views: ["detail", "fetch", "summary"], searchable: true },
    { expr: "pub_date", alias: "date", requires: ["pub_date"], views: ["detail", "fetch", "summary"] },
    { expr: "country", views: ["detail", "fetch", "summary"] },
    { expr: "spatial", views: ["detail", "fetch", "summary"], searchable: true },
    { expr: "coordinates", views: ["detail", "fetch", "summary"] },
    { expr: "subject", views: ["detail", "fetch", "summary"], searchable: true },
    { expr: "rights", views: ["detail"] },
    { expr: "description", views: ["detail", "fetch"], body: true, searchable: true },
  ],
};

/** The bare column a field depends on (its schema key), for the derived maps. */
function baseColumn(field: SubsetField): string {
  return (field.requires ?? [field.expr])[0];
}

/**
 * Build a subset's SELECT list for one view. `fetch` re-aliases the body column
 * to the contract key `text`; every other view keeps the field's own alias.
 */
export function colsFor(subset: Subset, schema: Set<string>, view: FieldView): string {
  const chain = new Set<FieldView>([view]);
  for (let base = VIEW_BASE[view]; base; base = VIEW_BASE[base]) chain.add(base);

  const items: Array<string | [string, string, string[]?]> = [];
  for (const field of SUBSET_FIELDS[subset]) {
    if (!field.views.some((v) => chain.has(v))) continue;
    const alias = view === "fetch" && field.body ? "text" : field.alias;
    if (alias === undefined) items.push(field.expr);
    else items.push([field.expr, alias, field.requires ?? [field.expr]]);
  }
  return selectList(schema, items);
}

/**
 * The free-text columns each subset's keyword search matches against. Consumed
 * by the per-subset `keyword` filters, the unified `search` tool, and
 * get_temporal_distribution — so adding a column to a subset's searchable
 * surface is a single `searchable: true` above.
 */
export const TEXT_COLS: Record<Subset, string[]> = Object.fromEntries(
  ALL_SUBSETS.map((s) => [s, SUBSET_FIELDS[s].filter((f) => f.searchable).map(baseColumn)]),
) as Record<Subset, string[]>;

/**
 * The CHEAP half of each subset's search surface: titles, subjects, AI abstracts,
 * tables of contents — everything except the full-text blobs tagged `heavy`.
 * The unified `search` matches these first and only falls back to the OCR scan
 * when the fast pass under-fills the page, which is the difference between a
 * ~150 ms and a ~3 s response on the tool that skill-less clients call most.
 * The per-subset `keyword` filters deliberately keep using the full TEXT_COLS —
 * they are the "search the full text" tools and their callers asked for that.
 */
export const FAST_TEXT_COLS: Record<Subset, string[]> = Object.fromEntries(
  ALL_SUBSETS.map((s) => [s, SUBSET_FIELDS[s].filter((f) => f.searchable && !f.heavy).map(baseColumn)]),
) as Record<Subset, string[]>;

/** Subsets whose search surface has a `heavy` column worth a second pass. */
export const HAS_HEAVY_TEXT: Record<Subset, boolean> = Object.fromEntries(
  ALL_SUBSETS.map((s) => [s, SUBSET_FIELDS[s].some((f) => f.searchable && f.heavy)]),
) as Record<Subset, boolean>;

/**
 * The canonical IWAC item page for an `o:id`. Every subset resolves under the
 * same path, and `iwac_url` stores exactly this. Used as a FALLBACK when the
 * stored value is blank: ChatGPT builds citation metadata only when `url` is a
 * non-empty string, and the result compaction drops empty strings, so an item
 * with an unfilled `iwac_url` would otherwise come back uncitable.
 */
export function itemUrl(id: string | number): string {
  return `https://islam.zmo.de/s/afrique_ouest/item/${id}`;
}

/**
 * The column holding each subset's display title (the index subset uses the
 * French "Titre"). Derived from the field tagged with the `title` output key, so
 * it cannot disagree with what the projections actually select.
 */
export const TITLE_COL: Record<Subset, string> = Object.fromEntries(
  ALL_SUBSETS.map((s) => {
    const field = SUBSET_FIELDS[s].find((f) => (f.alias ?? f.expr) === "title");
    if (!field) throw new Error(`SUBSET_FIELDS.${s} declares no field aliased to 'title'`);
    return [s, baseColumn(field)];
  }),
) as Record<Subset, string>;

// -----------------------------------------------------------------------------
// Aggregation / text helpers
// -----------------------------------------------------------------------------

export function rowsToMap(rows: Record<string, unknown>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.k == null || String(r.k).trim() === "") continue;
    out[String(r.k)] = Number(r.c);
  }
  return out;
}

export interface CappedText {
  text: string;
  truncated: boolean;
  truncation_message?: string;
}

/**
 * Cap a free-text field at `CHARACTER_LIMIT` so a single OCR blob can't flood the
 * model's context. When truncated, returns a message; `suggestKeyword` tailors it
 * toward the keyword-excerpt path on full-text tools.
 */
export function capText(
  text: string,
  opts: { suggestKeyword?: boolean; limit?: number } = {},
): CappedText {
  const limit = opts.limit ?? CHARACTER_LIMIT;
  if (text.length <= limit) return { text, truncated: false };
  const hint = opts.suggestKeyword
    ? " Pass a `keyword` to retrieve focused excerpts around matches instead."
    : " Narrow the request to see the rest.";
  return {
    text: text.slice(0, limit),
    truncated: true,
    truncation_message: `Text truncated from ${text.length} to ${limit} characters.${hint}`,
  };
}

/**
 * Accent/case-fold a string for in-JS matching. Mirrors the SQL-side
 * strip_accents(lower()) so keyword-excerpt extraction agrees with what the SQL
 * search matched. Input is NFC-normalised first: SQL strip_accents also folds
 * DECOMPOSED accents (e + U+0301), but the per-char regex below only sees
 * precomposed ones — without the normalize, an NFD OCR blob that search_articles
 * matched would report "keyword not found" on the excerpt path.
 *
 * Index-stability: for NFC input the fold maps each UTF-16 unit to exactly one
 * unit, so offsets into the folded string remain valid in the (NFC) original —
 * keywordExcerpts relies on this and normalises its haystack before slicing.
 *
 * The character class spans BOTH Latin blocks DuckDB's strip_accents folds:
 * Latin-1 Supplement + Latin Extended-A/B (U+00C0–U+024F, the French accents)
 * AND Latin Extended Additional (U+1E00–U+1EFF), which carries the dot-below /
 * dot-above letters used by scholarly Arabic transliteration (ḥadīth, Ṣūfī,
 * Muḥammad) and by Yoruba/Igbo orthography (Ẹ, ọ, ṣ). Omitting the second block
 * desynchronised the two folds: SQL matched `Muhammad` against an OCR blob
 * containing `Muḥammad`, then the excerpt path folded only the query and
 * reported "keyword not found in full text" for an item search had just returned.
 */
export function foldText(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[À-ɏḀ-ỿ]/g, (c) => c.normalize("NFD")[0] ?? c);
}

/** TOC entries (paragraph-separated) that contain `keyword`, accent-insensitively. */
export function extractMatchingTocEntries(toc: string, keyword: string): string {
  if (!toc || !keyword) return "";
  const kw = foldText(keyword);
  const entries = toc.split(/\n\n+/).map((s) => s.trim()).filter(Boolean);
  return entries.filter((e) => foldText(e).includes(kw)).join("\n\n");
}

export interface ExcerptResult {
  excerpts: string[];
  excerpts_returned: number;
  match_count: number;
  note?: string;
  /** Set when `context_chars`/`max_excerpts` were clamped into their legal range. */
  parameter_note?: string;
  truncated?: boolean;
  truncation_message?: string;
}

/** Report any argument this call silently clamped, so `max_excerpts: -3`
 * returning one excerpt cannot be misread as "there is only one match". */
function clampNote(opts: { contextChars?: number; maxExcerpts?: number }, applied: { contextChars: number; maxExcerpts: number }): string | undefined {
  const notes: string[] = [];
  if (opts.contextChars !== undefined && opts.contextChars !== applied.contextChars) {
    notes.push(`context_chars ${opts.contextChars} clamped to ${applied.contextChars} (allowed 200–5000)`);
  }
  if (opts.maxExcerpts !== undefined && opts.maxExcerpts !== applied.maxExcerpts) {
    notes.push(`max_excerpts ${opts.maxExcerpts} clamped to ${applied.maxExcerpts} (allowed 1–25)`);
  }
  return notes.length ? `${notes.join("; ")}.` : undefined;
}

/**
 * Keyword-in-context retrieval for a long OCR blob: find every accent-insensitive
 * match and return a window of `context_chars` (half each side) around each, up to
 * `max_excerpts` / CHARACTER_LIMIT total. Lets the model read just the relevant
 * passages of a long document/issue instead of the whole (capped) OCR. Shared by
 * get_publication_fulltext, get_document, and get_article.
 *
 * Accent/case-folding is index-stable for NFC text (foldText maps each UTF-16
 * unit to exactly one unit), so the OCR is NFC-normalised up front and sliced in
 * that form — match offsets stay valid and excerpt extraction agrees with the
 * accent-insensitive SQL search that found the item.
 */
export function keywordExcerpts(
  ocr: string,
  keyword: string,
  opts: { contextChars?: number; maxExcerpts?: number } = {},
): ExcerptResult {
  const contextChars = Math.max(200, Math.min(opts.contextChars ?? 2000, 5000));
  const maxExcerpts = capLimit(opts.maxExcerpts, 10, 25);
  const half = Math.floor(contextChars / 2);
  ocr = ocr.normalize("NFC"); // keep fold offsets valid in the sliced text
  const haystack = foldText(ocr);
  const needle = foldText(keyword);

  // All match positions first (cheap), then excerpts up to the caps. A common
  // keyword in a 1M-char issue can match hundreds of times — uncapped, that once
  // produced a single ~150k-char (~38k-token) response.
  const positions: number[] = [];
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    positions.push(idx);
    pos = idx + Math.max(1, needle.length);
  }
  const parameterNote = clampNote(opts, { contextChars, maxExcerpts });
  if (positions.length === 0) {
    return {
      excerpts: [],
      excerpts_returned: 0,
      match_count: 0,
      note: `Keyword '${keyword}' not found in full text`,
      ...(parameterNote ? { parameter_note: parameterNote } : {}),
    };
  }

  const excerpts: string[] = [];
  let coveredUntil = -1; // skip matches already visible in the previous excerpt
  let totalChars = 0;
  let capped = false;
  for (const idx of positions) {
    if (idx < coveredUntil) continue;
    if (excerpts.length >= maxExcerpts || totalChars >= CHARACTER_LIMIT) {
      capped = true;
      break;
    }
    const start = Math.max(0, idx - half);
    const end = Math.min(ocr.length, idx + needle.length + half);
    let ex = ocr.slice(start, end);
    if (start > 0) ex = `...${ex}`;
    if (end < ocr.length) ex += "...";
    excerpts.push(ex);
    totalChars += ex.length;
    coveredUntil = end;
  }

  const result: ExcerptResult = {
    excerpts,
    excerpts_returned: excerpts.length,
    match_count: positions.length,
    ...(parameterNote ? { parameter_note: parameterNote } : {}),
  };
  if (capped) {
    result.truncated = true;
    result.truncation_message =
      `Showing ${excerpts.length} excerpts for ${positions.length} matches. ` +
      `Use a more specific keyword, or raise max_excerpts (max 25).`;
  }
  return result;
}

/**
 * Attach a long OCR body to a detail row: with a keyword, replace the raw text
 * with keyword-in-context excerpts; without one, cap it and flag truncation.
 * Shared by get_article and get_document (get_publication_fulltext keeps its
 * own flow — different response keys: fulltext, char_count, tableOfContents).
 */
export function attachOcrOrExcerpts(
  row: Record<string, unknown>,
  ocrKey: string,
  keyword: string | undefined,
  opts: { contextChars?: number; maxExcerpts?: number } = {},
): void {
  const ocr = typeof row[ocrKey] === "string" ? (row[ocrKey] as string) : "";
  if (keyword && ocr.trim()) {
    delete row[ocrKey];
    Object.assign(row, keywordExcerpts(ocr, keyword, opts));
  } else if (ocr) {
    const capped = capText(ocr, { suggestKeyword: true });
    row[ocrKey] = capped.text;
    if (capped.truncated) {
      row.truncated = true;
      row.truncation_message = capped.truncation_message;
    }
  }
}
