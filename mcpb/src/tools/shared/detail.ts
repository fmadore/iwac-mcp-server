import { ensureView, getById } from "../../db.js";
import type { Subset } from "../../config.js";
import { colsFor } from "./fields.js";
import { errorResult, textResult } from "./results.js";
import { attachOcrOrExcerpts } from "./text.js";

/**
 * The body of every get_<item> tool: one record's `detail` projection, or a
 * not-found error naming what was asked for.
 *
 * `text` names the long body column, which is capped (or replaced by keyword
 * excerpts) on the way out. Routing the five tools through one place is the
 * point: get_audiovisual was the one tool that returned its body raw, and a
 * transcription can run to ~470k characters.
 */
export async function detailResult(
  subset: Subset,
  label: string,
  id: number,
  text?: { key: string; keyword?: string; contextChars?: number; maxExcerpts?: number; offset?: number },
): Promise<ReturnType<typeof textResult> | ReturnType<typeof errorResult>> {
  const schema = await ensureView(subset);
  const row = await getById(subset, colsFor(subset, schema, "detail"), id);
  if (!row) return errorResult({ error: `${label} ${id} not found` });
  if (text) {
    const { key, keyword, ...opts } = text;
    attachOcrOrExcerpts(row, key, keyword, opts);
  }
  return textResult(row);
}
