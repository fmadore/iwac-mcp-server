import { VIEW_DATA_META_KEY } from "../../viewContract.js";

type McpServer = import("@modelcontextprotocol/server").McpServer;

/**
 * The registration surface tool, resource and prompt modules are handed.
 * Deliberately narrower than McpServer: tools/register.ts records these calls
 * once per process and replays them onto every server the factory builds, so
 * a module reaching for any other member would escape the replay. Typing it
 * this narrowly makes that a compile error rather than a startup crash.
 */
export type Server = Pick<McpServer, "registerTool" | "registerResource" | "registerPrompt">;

// -----------------------------------------------------------------------------
// Tool result / annotation helpers
// -----------------------------------------------------------------------------

/**
 * The behaviour hints every IWAC tool shares. The display name lives in the
 * tool's own top-level `title`, which hosts prefer over `annotations.title`;
 * repeating it here cost ~6 tokens per tool on every turn (the AMIRA server
 * dropped the same duplicate). The explicit read-only, non-destructive and
 * closed-world hints stay: ChatGPT's connector review reads them.
 */
export function annotate() {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

/**
 * Standard registerTool metadata: a top-level `title` plus the read-only
 * annotation set. Spread into every tool's config.
 */
export function toolMeta(title: string, options: { openWorldHint?: boolean } = {}): { title: string; annotations: ReturnType<typeof annotate> } {
  return { title, annotations: { ...annotate(), ...options } };
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
function compactValue(value: unknown, preserveNulls = false): unknown {
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map((item) => compactValue(item, preserveNulls));
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || (v === null && !preserveNulls)) continue;
      if (typeof v === "string" && v.trim().length === 0) continue;
      out[k] = compactValue(v, preserveNulls);
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
export function structuredResult(payload: unknown, options?: { preserveNulls?: boolean }): {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
} {
  const compacted = compactValue(payload, options?.preserveNulls) as Record<string, unknown>;
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
 * Stable machine codes for tool errors, so a model (or a test) can branch on
 * the kind of failure rather than parse its wording:
 *   invalid_argument  the call can be corrected (bad value, missing field, typo)
 *   not_found         the id names no record in the loaded snapshot
 *   unavailable       this dataset revision or configuration cannot answer it
 *                     (missing column, semantic search off or unable to run)
 *   data_error        stored data failed validation; retrying will not help
 */
export type ErrorCode = "invalid_argument" | "not_found" | "unavailable" | "data_error";

/** The code an uncoded `{ error }` message implies. Explicit codes win. */
export function inferErrorCode(message: string): ErrorCode {
  if (/\bnot found\b|^No \S+ item with id/i.test(message)) return "not_found";
  if (/embedding validation|invalid or zero embedding|no readable result/i.test(message)) return "data_error";
  if (/dataset revision|^No (?:body text|full-text) column|^No publication date in|not enabled|cannot run/i.test(message))
    return "unavailable";
  return "invalid_argument";
}

/**
 * Like `textResult`, but marks the result as a tool-level error (`isError: true`)
 * per MCP guidance, so the model recognises the failure and can self-correct
 * (e.g. a missing id, semantic search disabled) rather than treating the error
 * JSON as a successful result. Reserve this for genuine failures — an empty or
 * "no matches" result is a successful call and should use `textResult`.
 *
 * Every `{ error: "…" }` payload gains a stable `code` (see ErrorCode),
 * given explicitly or inferred from the message. The `error` text and its
 * companions (`valid_values`, `hint`, …) are unchanged, so the addition
 * breaks no reader of the existing shape.
 */
export function errorResult(payload: unknown, code?: ErrorCode): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  const coded =
    payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
      ? { code: code ?? inferErrorCode((payload as { error: string }).error), ...(payload as Record<string, unknown>) }
      : payload;
  return { content: textResult(coded).content, isError: true };
}

