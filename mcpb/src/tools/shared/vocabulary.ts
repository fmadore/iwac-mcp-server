import { z } from "zod";
import { foldText } from "./text.js";

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
 * Audiovisual `source_type`: which of the subset's two populations a row belongs
 * to. `youtube` rows (1,724 as of 2026-08-17, still being harvested) have a watch
 * URL and no file; `deposited` rows (47) have a file, a `creator` and an IIIF
 * manifest. This is the split to filter on — `medium` describes the carrier and
 * `type` is the same value for every row in the subset, so neither separates the
 * two cohorts reliably.
 */
export const SOURCE_TYPE_VALUES = ["youtube", "deposited"] as const;

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

/** AI polarity labels (articles); same six-point scale for every panel model. */
export const POLARITY_VALUES = ["Très positif", "Positif", "Neutre", "Négatif", "Très négatif", "Non applicable"] as const;

/** AI centrality labels (articles); same five-point scale for every panel model. */
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

