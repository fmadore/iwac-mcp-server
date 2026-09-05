import { CHARACTER_LIMIT, capLimit } from "./limits.js";

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

