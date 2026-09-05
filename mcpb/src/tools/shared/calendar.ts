import { q, type Bindable } from "../../db.js";
import { foldText } from "./text.js";

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
 * Render one Hijri column as a bucket/date part.
 *
 * The three columns are stored as DOUBLE in the parquet, so the INTEGER cast is
 * load-bearing, not defensive: `CAST(3.0 AS VARCHAR)` is `'3.0'`, and DuckDB's
 * `lpad` TRUNCATES a string that is already longer than the target width rather
 * than leaving it alone — so padding it to 2 yielded `'3.'`, and an unpadded
 * year yielded `'1440.0'`. Both read as plausible until you compare them with
 * something: a month bucket matched no `month_labels` key, and every single
 * `hijri_date` was malformed. Anything reading these columns as text must go
 * through here.
 */
export const hijriPart = (column: string, pad = 2): string => {
  const int = `CAST(CAST(${q(column)} AS INTEGER) AS VARCHAR)`;
  return pad ? `lpad(${int}, ${pad}, '0')` : int;
};

/**
 * The lunar date as one `1440-09-15` string, mirroring how `pub_date` reads.
 * Numeric parts rather than a month name: the name would have to be a 12-branch
 * CASE in SQL that then drifts from HIJRI_MONTHS, and the model already has that
 * table from `month_labels`.
 */
export const HIJRI_DATE_EXPR =
  `CASE WHEN "hijri_year" IS NULL THEN NULL ELSE ${hijriPart("hijri_year", 0)} || '-' || ` +
  `${hijriPart("hijri_month")} || '-' || ${hijriPart("hijri_day")} END`;

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

