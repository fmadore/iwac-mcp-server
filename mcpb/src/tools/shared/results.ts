import { VIEW_DATA_META_KEY } from "../../viewContract.js";

/** The McpServer type, aliased once so tool modules don't repeat the import path. */
export type Server = import("@modelcontextprotocol/server").McpServer;

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

