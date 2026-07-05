// Shared runner for the semantic_search_* tools. Both tools follow the same
// shape — SQL-prefilter candidates, embed the query, dot-product top-k, then
// re-fetch summary rows in similarity order — so the flow lives here once and
// each tool supplies only its subset specifics. A future
// semantic_search_references (pending the embedding_abstract column) plugs in
// the same way.
import { ensureView, getManyByIds, query, viewName } from "../db.js";
import { semanticSearch } from "../embeddings.js";
import type { Subset } from "../config.js";
import {
  errorResult,
  limitWarning,
  textResult,
  type ResolvedLimit,
} from "./_shared.js";

export async function runSemanticSearchTool(opts: {
  subset: Subset;
  embeddingColumn: string;
  query: string;
  limit: ResolvedLimit;
  /** SELECT list for the summary rows, given the live schema. */
  summaryCols: (schema: Set<string>) => string;
  /** Append subset-specific SQL prefilters (country, newspaper, dates…). */
  buildCandidateFilters?: (schema: Set<string>, where: string[], params: unknown[]) => void;
  /** Echoed back as `filters` so the model sees which filters applied. */
  filtersEcho: Record<string, unknown>;
}): Promise<ReturnType<typeof textResult> | ReturnType<typeof errorResult>> {
  const { subset, embeddingColumn, query: queryStr, limit } = opts;
  try {
    const schema = await ensureView(subset);
    const cols = opts.summaryCols(schema);

    // Optional SQL prefilter: semantic ranking then runs only over the
    // candidate ids, so metadata filters compose with similarity search.
    const candidateWhere: string[] = [];
    const candidateParams: unknown[] = [];
    opts.buildCandidateFilters?.(schema, candidateWhere, candidateParams);
    const candidateRows = candidateWhere.length
      ? await query(
          `SELECT CAST("o:id" AS VARCHAR) AS id FROM ${viewName(subset)} WHERE ${candidateWhere.join(" AND ")}`,
          candidateParams,
        )
      : null;
    const candidateIds = candidateRows?.map((r) => String(r.id));

    const hits = await semanticSearch({
      subset,
      embeddingColumn,
      query: queryStr,
      limit: limit.value,
      candidateIds,
    });

    const rows = await getManyByIds(subset, cols, hits.map((h) => h.id));
    const byId = new Map(rows.map((r) => [String(r.id), r]));

    // Walk hits in similarity order, keeping those that survived the filters.
    const results: Record<string, unknown>[] = [];
    for (const h of hits) {
      const row = byId.get(h.id);
      if (!row) continue;
      results.push({ ...row, similarity_score: Number(h.score.toFixed(4)) });
      if (results.length >= limit.value) break;
    }
    return textResult({
      query: queryStr,
      count: results.length,
      limit: limit.value,
      ...limitWarning(limit),
      filters: opts.filtersEcho,
      ...(candidateIds ? { candidate_count: candidateIds.length } : {}),
      results,
    });
  } catch (err) {
    return errorResult({ error: String((err as Error).message ?? err) });
  }
}
