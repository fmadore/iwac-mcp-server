import { z } from "zod";
import { CHARACTER_LIMIT, resolveLimit } from "./limits.js";

/** The `offset` input of the four full-text tools; see pageText. */
export const textOffsetParam = () =>
  z.number().int().optional().describe("Read from this character on: the previous part's next_offset");

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

/**
 * `i`, moved back one unit if it would cut an astral character (an emoji, a
 * rare CJK or historic-script letter) between its two UTF-16 halves.
 * String.slice counts UTF-16 units, so a cut there left a lone surrogate at
 * the edge of the text. JSON serialises that as an escape such as "\udd4c",
 * and the reader gets noise where a character was. YouTube titles and
 * descriptions in the audiovisual subset carry emoji routinely.
 */
export function codePointBoundary(s: string, i: number): number {
  if (i <= 0 || i >= s.length) return i;
  const low = s.charCodeAt(i);
  const high = s.charCodeAt(i - 1);
  return low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? i - 1 : i;
}

export interface CappedText {
  text: string;
  truncated: boolean;
  truncation_message?: string;
}

/**
 * Cap a free-text field at `CHARACTER_LIMIT` so a single OCR blob can't flood the
 * model's context. The full-text tools page instead (pageText), so the rest
 * stays readable; this is for text with no tool to read on in.
 */
export function capText(text: string, opts: { limit?: number } = {}): CappedText {
  const limit = opts.limit ?? CHARACTER_LIMIT;
  if (text.length <= limit) return { text, truncated: false };
  return {
    text: text.slice(0, codePointBoundary(text, limit)),
    truncated: true,
    truncation_message: `Text truncated from ${text.length} to ${limit} characters. Narrow the request to see the rest.`,
  };
}

export interface TextPage {
  text: string;
  /** Where this part starts, after any surrogate-pair adjustment. */
  offset: number;
  /** Where the next part starts; absent when this part reaches the end. */
  next_offset?: number;
  char_count: number;
}

/**
 * One CHARACTER_LIMIT-sized part of a long body, starting at `offset`.
 *
 * The cap alone made everything past the first 25,000 characters unreachable
 * except through keyword excerpts: most publication issues (up to ~1.1M
 * characters), the longest sermon transcriptions (~470k) and a few documents
 * and articles. A user who asked for the whole text could not have it. Each
 * part ends where the next begins, so following `next_offset` reads the body
 * end to end without gaps or overlap.
 */
export function pageText(text: string, offset = 0): TextPage {
  const start = codePointBoundary(text, Math.min(Math.max(0, offset), text.length));
  const end = codePointBoundary(text, Math.min(text.length, start + CHARACTER_LIMIT));
  return {
    text: text.slice(start, end),
    offset: start,
    ...(end < text.length ? { next_offset: end } : {}),
    char_count: text.length,
  };
}

/** How to read on from a part that stops short of the end. */
export function continueMessage(page: TextPage, tool?: string): string {
  const call = tool ? `Call ${tool} with` : "Pass";
  return (
    `Showing characters ${page.offset}–${page.offset + page.text.length} of ${page.char_count}. ` +
    `${call} offset ${page.next_offset} to read on, or a \`keyword\` for excerpts around matches.`
  );
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
 *
 * U+0130 (İ, dotted capital I) is mapped to a plain I before lowercasing
 * because it is the ONE code point whose toLowerCase() is longer than itself
 * ("i" + combining dot, two units). Left alone, each occurrence shifted every
 * later excerpt offset by one. DuckDB folds it to a bare "i", so this also keeps
 * the two folds in agreement.
 */
export function foldText(s: string): string {
  return s
    .normalize("NFC")
    .replace(/\u0130/g, "I")
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
  const maxExcerpts = resolveLimit(opts.maxExcerpts, 10, 25).value;
  const half = Math.floor(contextChars / 2);
  ocr = ocr.normalize("NFC"); // keep fold offsets valid in the sliced text
  const haystack = foldText(ocr);
  const needle = foldText(keyword);

  // indexOf("", position) keeps returning the end of the string even when
  // position is past it. Reject blank needles before that loop can run forever.
  if (!needle.trim()) {
    return { excerpts: [], excerpts_returned: 0, match_count: 0, note: "A nonempty keyword is required" };
  }

  // Count every match, retaining only the bounded context windows. Common
  // one-character terms must not allocate an array proportional to OCR length.
  const excerpts: string[] = [];
  let matchCount = 0;
  let coveredUntil = -1;
  let totalChars = 0;
  let capped = false;
  let pos = 0;
  while (pos <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    matchCount++;
    pos = idx + needle.length;
    if (idx < coveredUntil) continue;
    if (excerpts.length >= maxExcerpts || totalChars >= CHARACTER_LIMIT) {
      capped = true;
      continue;
    }
    const start = codePointBoundary(ocr, Math.max(0, idx - half));
    const end = codePointBoundary(ocr, Math.min(ocr.length, idx + needle.length + half));
    let ex = ocr.slice(start, end);
    if (start > 0) ex = `...${ex}`;
    if (end < ocr.length) ex += "...";
    excerpts.push(ex);
    totalChars += ex.length;
    coveredUntil = end;
  }
  const parameterNote = clampNote(opts, { contextChars, maxExcerpts });
  if (matchCount === 0) {
    return {
      excerpts: [],
      excerpts_returned: 0,
      match_count: 0,
      note: `Keyword '${keyword}' not found in full text`,
      ...(parameterNote ? { parameter_note: parameterNote } : {}),
    };
  }

  const result: ExcerptResult = {
    excerpts,
    excerpts_returned: excerpts.length,
    match_count: matchCount,
    ...(parameterNote ? { parameter_note: parameterNote } : {}),
  };
  if (capped) {
    result.truncated = true;
    result.truncation_message =
      `Showing ${excerpts.length} excerpts for ${matchCount} matches. ` +
      `Use a more specific keyword, or raise max_excerpts (max 25).`;
  }
  return result;
}

/**
 * Excerpts search the whole text, so an `offset` passed beside a keyword
 * changes nothing. Say so rather than let the caller believe it narrowed the
 * scan.
 */
export function noteIgnoredOffset(excerpts: ExcerptResult, offset: number | undefined): ExcerptResult {
  if (!offset) return excerpts;
  const note = "offset ignored: a keyword searches the whole text.";
  return { ...excerpts, parameter_note: excerpts.parameter_note ? `${excerpts.parameter_note} ${note}` : note };
}

/**
 * The paging fields for one part of a body, keyed for a detail row: nothing
 * extra when the whole text fits in one part, so short items read as before.
 * `bodyKey` holds the text, or is dropped with a note when `offset` is past
 * the end. Shared by attachOcrOrExcerpts and get_publication_fulltext.
 */
export function pagedBody(text: string, bodyKey: string, offset: number | undefined): Record<string, unknown> {
  if (offset !== undefined && offset >= text.length) {
    return { char_count: text.length, note: `offset ${offset} is past the end of the text (${text.length} characters)` };
  }
  const page = pageText(text, offset);
  const out: Record<string, unknown> = { [bodyKey]: page.text };
  if (page.offset === 0 && page.next_offset === undefined) return out;
  out.char_count = page.char_count;
  if (page.offset > 0) out.offset = page.offset;
  if (page.next_offset !== undefined) {
    out.next_offset = page.next_offset;
    out.truncated = true;
    out.truncation_message = continueMessage(page);
  }
  return out;
}

/**
 * Attach a long OCR body to a detail row: with a keyword, replace the raw text
 * with keyword-in-context excerpts; without one, return the part starting at
 * `offset` (default the start) and say how to read on. Shared by get_article,
 * get_document and get_audiovisual (get_publication_fulltext keeps its own
 * flow, with different response keys: fulltext, char_count, tableOfContents).
 */
export function attachOcrOrExcerpts(
  row: Record<string, unknown>,
  ocrKey: string,
  keyword: string | undefined,
  opts: { contextChars?: number; maxExcerpts?: number; offset?: number } = {},
): void {
  const ocr = typeof row[ocrKey] === "string" ? (row[ocrKey] as string) : "";
  if (keyword && ocr.trim()) {
    delete row[ocrKey];
    Object.assign(row, noteIgnoredOffset(keywordExcerpts(ocr, keyword, opts), opts.offset));
  } else if (ocr) {
    const paged = pagedBody(ocr, ocrKey, opts.offset);
    if (!(ocrKey in paged)) delete row[ocrKey];
    Object.assign(row, paged);
  }
}
