import { createHash } from "node:crypto";
import { codePointBoundary, foldText } from "../shared/text.js";

export interface ConcordanceContext {
  term: string;
  match: string;
  left: string;
  right: string;
  /** UTF-16 offsets into the stored body; absent if normalization changed it. */
  start?: number;
  end?: number;
  offset_unit?: "utf16";
}

/** Count literal matches with bounded context storage, including very long OCR. */
export function concordanceContexts(source: string, terms: string[], sourceField: string) {
  const normalized = source.normalize("NFC");
  const haystack = foldText(normalized);
  const reliableOffsets = normalized === source && haystack.length === source.length;
  const hash = createHash("sha256").update(source).digest("hex");
  const contexts: ConcordanceContext[] = [];
  const excerpts: string[] = [];
  const matchedTerms: string[] = [];
  const seen = new Set<string>();
  let matchCount = 0;
  for (const raw of terms) {
    const term = raw.trim();
    const needle = foldText(term);
    if (!needle || seen.has(needle)) continue;
    seen.add(needle);
    let position = 0;
    let coveredUntil = -1;
    let matched = false;
    while (position <= haystack.length - needle.length) {
      const start = haystack.indexOf(needle, position);
      if (start < 0) break;
      const end = start + needle.length;
      position = end;
      matchCount++;
      matched = true;
      // A future fold that expands characters must never slice the source at
      // shifted positions. Counts still remain useful without excerpts.
      if (haystack.length !== normalized.length || contexts.length >= 3 || start < coveredUntil) continue;
      const leftStart = codePointBoundary(normalized, Math.max(0, start - 200));
      const rightEnd = codePointBoundary(normalized, Math.min(normalized.length, end + 200));
      coveredUntil = rightEnd;
      contexts.push({
        term,
        match: normalized.slice(start, end),
        left: normalized.slice(leftStart, start),
        right: normalized.slice(end, rightEnd),
        ...(reliableOffsets ? { start, end, offset_unit: "utf16" as const } : {}),
      });
      excerpts.push(`${leftStart ? "..." : ""}${normalized.slice(leftStart, rightEnd)}${rightEnd < normalized.length ? "..." : ""}`);
    }
    if (matched) matchedTerms.push(term);
  }
  return {
    contexts,
    excerpts,
    matched_terms: matchedTerms,
    match_count: matchCount,
    source_field: sourceField,
    source_text_sha256: hash,
    source_offsets_available: reliableOffsets,
  };
}
