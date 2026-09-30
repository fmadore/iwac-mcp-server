/** Research workbench: one selection contract, all subsets, source-backed views. */
import { chartResult } from "./shared/chartResults.js";
import { z } from "zod";
import { ALL_SUBSETS, type Subset } from "../config.js";
import { ensureView, q, query, queryScalarSingle, viewName, type Row } from "../db.js";
import { aggregateFilters, filterInputs } from "./aggregates/shared.js";
import { bodyColumn, EMBEDDING_COLUMNS } from "./shared/research.js";
import { colsFor, itemUrl, TITLE_COL } from "./shared/fields.js";
import { annotate, errorResult, keywordExcerpts, type Server } from "./_shared.js";
import { CHARTS_UI_META } from "./appUi.js";
import { SENTIMENT_MODELS, sentimentCols } from "./shared/sentiment.js";

const selectionSchema = z.object({
  ...filterInputs(),
  hijri_month: z.string().optional(),
  hijri_year: z.number().int().optional(),
});
const rowSchema = z.record(z.string(), z.unknown());
const output = z.object({
  view: z.enum(["records", "coverage", "comparison", "attention", "aliases"]),
  subset: z.string(),
  filters: rowSchema,
  rows: z.array(rowSchema),
  total_matches: z.number(),
  note: z.string().optional(),
  offset: z.number().optional(),
  limit: z.number().optional(),
  has_more: z.boolean().optional(),
  mode: z.string().optional(),
  source_field: z.string().optional(),
  metrics: rowSchema.optional(),
  selections: z.array(rowSchema).optional(),
  overlap: z.number().optional(),
  omitted_cells: z.number().optional(),
});
const whereSql = (where: string[]) => (where.length ? where.join(" AND ") : "TRUE");
const count = async (v: string, f: ReturnType<typeof aggregateFilters>) =>
  Number(await queryScalarSingle(`SELECT COUNT(*) FROM ${v} WHERE ${whereSql(f.where)}`, f.params));
const present = (col: string | undefined) =>
  col ? `NULLIF(TRIM(CAST(${q(col)} AS VARCHAR)), '') IS NOT NULL` : "FALSE";

export function registerResearchTools(server: Server): void {
  server.registerTool(
    "explore_corpus",
    {
      title: "Research workbench",
      annotations: annotate("Research workbench"),
      _meta: CHARTS_UI_META,
      description:
        "Inspect a reproducible selection: items or concordance (keyword contexts), source×year coverage, compare two selections, publication-country×mentioned-place attention, or authority aliases. Exact filters intersect; aliases are suggestions, never silently applied. Coverage reports availability, not historical prevalence. Compare requires comparison. Lists paginate with offset; charts disclose caps.",
      inputSchema: z.object({
        mode: z.enum(["items", "concordance", "coverage", "compare", "attention", "aliases"]).default("items"),
        subset: z.enum(ALL_SUBSETS as [Subset, ...Subset[]]).default("articles"),
        selection: selectionSchema.optional(),
        comparison: selectionSchema.optional(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      outputSchema: output,
    },
    async ({ mode, subset: requested, selection = {}, comparison, offset, limit }) => {
      const subset = mode === "aliases" ? "index" : requested;
      const schema = await ensureView(subset),
        v = viewName(subset);
      const f = aggregateFilters(subset, schema, selection);
      if (f.err) return errorResult(f.err);
      const total = await count(v, f);
      const base = { subset, filters: f.echo, total_matches: total };
      const body = bodyColumn(subset, schema);
      const embedding = EMBEDDING_COLUMNS[subset];
      const hasEmbedding =
        embedding && schema.has(embedding) ? `${q(embedding)} IS NOT NULL AND len(${q(embedding)}) > 0` : "FALSE";
      const scoredCols = SENTIMENT_MODELS.map((m) => sentimentCols(m).polarity).filter((c) => schema.has(c));
      const scored = scoredCols.length ? scoredCols.map((c) => `(${present(c)})`).join(" OR ") : "FALSE";
      const metrics = `COUNT(*) AS total, ${body ? `COUNT(*) FILTER (WHERE ${present(body)})` : "NULL"} AS fulltext, ${embedding && schema.has(embedding) ? `COUNT(*) FILTER (WHERE ${hasEmbedding})` : "NULL"} AS embedded, ${scoredCols.length ? `COUNT(*) FILTER (WHERE ${scored})` : "NULL"} AS scored`;

      if (mode === "items" || mode === "concordance" || mode === "aliases") {
        if (mode === "concordance" && !selection.keyword)
          return errorResult({ error: "Concordance requires selection.keyword" });
        if (mode === "concordance" && !body) return errorResult({ error: `No body text column in ${subset}` });
        const projection = colsFor(subset, schema, "summary");
        const rows = await query(
          `SELECT ${projection}${mode === "concordance" ? `, ${q(body ?? "")} AS context_text` : ""} FROM ${v} WHERE ${whereSql(f.where)} ORDER BY ${schema.has("pub_date") ? "pub_date DESC NULLS LAST, " : ""}"o:id" LIMIT ? OFFSET ?`,
          [...f.params, limit, offset],
        );
        for (const r of rows) {
          r.id = `${subset}:${r.id}`;
          r.url ||= itemUrl(String(r.id).split(":")[1]);
          if (mode === "concordance") {
            const terms =
              selection.keyword_mode === "all_terms"
                ? (selection.keyword ?? "").trim().split(/\s+/)
                : [selection.keyword ?? "", ...(selection.keyword_aliases ?? [])];
            const matches = terms.map((term) => ({
              term,
              ...keywordExcerpts(String(r.context_text ?? ""), term, { contextChars: 400, maxExcerpts: 3 }),
            }));
            r.excerpts = [...new Set(matches.flatMap((m) => m.excerpts))].slice(0, 3);
            r.matched_terms = matches.filter((m) => m.match_count > 0).map((m) => m.term);
            r.match_count = matches.reduce((n, m) => n + m.match_count, 0);
            delete r.context_text;
          }
        }
        return chartResult({
          ...base,
          view: mode === "aliases" ? "aliases" : "records",
          mode,
          rows,
          offset,
          limit,
          has_more: offset + rows.length < total,
          note:
            mode === "aliases"
              ? "Alternate titles are authority suggestions. Choose a term explicitly; expansions can change recall and meaning."
              : mode === "concordance"
                ? "Accent-insensitive literal contexts from stored body text, at most three per item. Metadata-only hits may have no context; missing text is not negative evidence."
                : "Ordered by stored date descending, then stable item ID. Open an item for text and canonical citation.",
        });
      }
      if (mode === "compare") {
        if (!comparison) return errorResult({ error: "Compare requires a second selection in comparison" });
        const b = aggregateFilters(subset, schema, comparison);
        if (b.err) return errorResult(b.err);
        const overlap = Number(
          await queryScalarSingle(`SELECT COUNT(*) FROM ${v} WHERE (${whereSql(f.where)}) AND (${whereSql(b.where)})`, [
            ...f.params,
            ...b.params,
          ]),
        );
        const selections: Row[] = [];
        const rows: Row[] = [];
        for (const [i, filter] of [f, b].entries()) {
          const m = (await query(`SELECT ${metrics} FROM ${v} WHERE ${whereSql(filter.where)}`, filter.params))[0];
          selections.push({ label: i === 0 ? "A" : "B", filters: filter.echo, ...m });
          for (const field of ["country", "newspaper", "lda_topic_id"])
            if (schema.has(field)) {
              const dist = await query(
                `SELECT CAST(${q(field)} AS VARCHAR) AS value, COUNT(*) AS count FROM ${v} WHERE ${whereSql(filter.where)} GROUP BY 1 ORDER BY 2 DESC, 1`,
                filter.params,
              );
              rows.push(
                ...dist.map((r) => ({
                  selection: i === 0 ? "A" : "B",
                  field,
                  value: r.value || "(missing)",
                  count: Number(r.count),
                  share: Number(m.total) ? Number(r.count) / Number(m.total) : 0,
                })),
              );
            }
        }
        // Rank on the combined base so the two sides always use the same categories.
        const ranked = new Map<string, number>();
        for (const r of rows) {
          const key = JSON.stringify([r.field, r.value]);
          ranked.set(key, (ranked.get(key) ?? 0) + Number(r.count));
        }
        const keys = new Set(
          [...ranked]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, 40)
            .map(([key]) => key),
        );
        const kept = rows.filter((r) => keys.has(JSON.stringify([r.field, r.value])));
        return chartResult({
          ...base,
          view: "comparison",
          rows: kept,
          selections,
          overlap,
          omitted_cells: rows.length - kept.length,
          note: "Shares use each selection's entire base, including missing values. Categories use stored labels (pipe-joined countries remain one category). Selections can overlap; differences are descriptive, not causal. Largest 40 combined categories shown.",
        });
      }
      if (mode === "coverage") {
        if (!schema.has("pub_date")) return errorResult({ error: `No publication date in ${subset}` });
        const source = schema.has("newspaper") ? "newspaper" : schema.has("country") ? "country" : TITLE_COL[subset];
        const rows = await query(
          `SELECT COALESCE(NULLIF(TRIM(${q(source)}), ''), '(missing)') AS source, COALESCE(NULLIF(regexp_extract(pub_date, '^(\\d{4})', 1), ''), '(undated)') AS year, ${metrics} FROM ${v} WHERE ${whereSql(f.where)} GROUP BY 1, 2 ORDER BY total DESC, 1, 2`,
          f.params,
        );
        return chartResult({
          ...base,
          view: "coverage",
          source_field: source,
          rows: rows.slice(0, 400),
          omitted_cells: Math.max(0, rows.length - 400),
          metrics: {
            fulltext: body ?? "unavailable",
            embedded: embedding && schema.has(embedding) ? embedding : "unavailable",
            scored: scoredCols,
          },
          note: "Cells count archived items, body-text availability, nonempty embeddings and at least one model polarity score. Availability does not certify OCR or vector quality. Missing dates are explicit; absent cells mean no archived records, not no historical activity. Largest 400 populated cells shown; availability is null when a column is unavailable. Known publication lifetimes are not inferred from archival gaps.",
        });
      }
      if (!["articles", "publications"].includes(subset))
        return errorResult({
          error:
            "Publication origins are defined only for articles and publications; other subsets use different country semantics",
        });
      if (!schema.has("country") || !schema.has("spatial"))
        return errorResult({ error: "Attention requires country and spatial metadata" });
      const rows = await query(
        `WITH selected AS (SELECT "o:id" AS id, country, spatial FROM ${v} WHERE ${whereSql(f.where)}), origins AS (SELECT DISTINCT id, TRIM(UNNEST(string_split(COALESCE(country,''), '|'))) AS origin, spatial FROM selected), mentions AS (SELECT DISTINCT id, origin, TRIM(UNNEST(string_split(COALESCE(spatial,''), '|'))) AS destination FROM origins) SELECT origin, destination, COUNT(DISTINCT id) AS count, (SELECT COUNT(DISTINCT id) FROM origins o WHERE o.origin = m.origin) AS denominator FROM mentions m WHERE origin <> '' AND destination <> '' GROUP BY 1, 2 ORDER BY count DESC, 1, 2`,
        f.params,
      );
      return chartResult({
        ...base,
        view: "attention",
        rows: rows.slice(0, 200),
        omitted_cells: Math.max(0, rows.length - 200),
        note: "Publication-country metadata × mentioned place tags, not routes, migration or information flows. A multi-tagged item can occur in several cells. Denominator is all selected items tagged with that origin country. Largest 200 populated cells shown.",
      });
    },
  );
}
