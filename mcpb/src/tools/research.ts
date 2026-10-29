/** Research workbench: one selection contract, all subsets, source-backed views. */
import { chartResult } from "./shared/chartResults.js";
import { structuredResult, viewResult } from "./shared/results.js";
import { z } from "zod";
import { ALL_SUBSETS, type Subset } from "../config.js";
import type { ComparisonRow, ComparisonSelection } from "../viewContract.js";
import { ensureView, q, query, queryScalarSingle, viewName } from "../db.js";
import { aggregateFilters, filterInputs } from "./aggregates/shared.js";
import { bodyColumn, embeddingColumn } from "./shared/research.js";
import { colsFor, itemUrl, TITLE_COL } from "./shared/fields.js";
import { keywordTerms } from "./shared/filters.js";
import { annotate, errorResult, type Server } from "./_shared.js";
import { CHARTS_UI_META } from "./appUi.js";
import { SENTIMENT_MODELS, sentimentCols } from "./shared/sentiment.js";
import { concordanceContexts } from "./research/concordance.js";
import { comparisonTimeline } from "./research/comparison.js";
import { EXPORT_MODES, type ExportMode, citationProjection, exportFile, isExportMode, researchExport } from "./researchExports.js";
import { INVALID_PARAMS, ProtocolError, ResourceTemplate } from "@modelcontextprotocol/server";
import { withRequest } from "../request.js";

const selectionSchema = z.strictObject({
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
  total_cells: z.number().optional(),
  source_exact_field: z.string().optional(),
  export: rowSchema.optional(),
  temporal: rowSchema.optional(),
});
const whereSql = (where: string[]) => (where.length ? where.join(" AND ") : "TRUE");
const count = async (v: string, f: ReturnType<typeof aggregateFilters>) =>
  Number(await queryScalarSingle(`SELECT COUNT(*) FROM ${v} WHERE ${whereSql(f.where)}`, f.params));

/**
 * Most items a linked export holds. A paged export puts up to 50 citations in
 * the conversation per call; a link puts none there, and the host reads the
 * whole selection as one file (the AMIRA server's `export` links work the same
 * way). Larger selections still page through the tool.
 */
export const EXPORT_LINK_MAX = 5_000;

/** `iwac://export/{mode}/{subset}/{selection}`, the selection as base64url JSON. */
export function exportUri(mode: ExportMode, subset: Subset, selection: Record<string, unknown>): string {
  return `iwac://export/${mode}/${subset}/${Buffer.from(JSON.stringify(selection)).toString("base64url")}`;
}

/** The citation rows of one export page, ids namespaced and URLs filled in. */
async function exportRows(subset: Subset, schema: Set<string>, v: string, f: ReturnType<typeof aggregateFilters>, limit: number, offset: number) {
  const rows = await query(
    `SELECT ${citationProjection(subset, schema)} FROM ${v} WHERE ${whereSql(f.where)} ORDER BY ${schema.has("pub_date") ? "pub_date DESC NULLS LAST, " : ""}"o:id" LIMIT ? OFFSET ?`,
    [...f.params, limit, offset],
  );
  for (const row of rows) {
    const id = String(row.id);
    row.id = `${subset}:${id}`;
    row.url ||= itemUrl(id);
  }
  return rows;
}
const present = (col: string | undefined) =>
  col ? `NULLIF(TRIM(CAST(${q(col)} AS VARCHAR)), '') IS NOT NULL` : "FALSE";

/**
 * Cell views (compare, coverage, attention): the model reads one `limit`-sized
 * page of the ranked cells and pages on with `offset`; the chart still receives
 * the largest `chartCap` cells through the widget-only channel, so it draws
 * the same picture whatever page the model asked for.
 */
function pagedCells<R>(
  payload: Record<string, unknown>,
  cells: R[],
  chartCap: number,
  { offset, limit }: { offset: number; limit: number },
) {
  const rows = cells.slice(offset, offset + limit);
  return viewResult(
    { ...payload, rows, offset, limit, has_more: offset + rows.length < cells.length, total_cells: cells.length },
    { rows: cells.slice(0, chartCap), omitted_cells: Math.max(0, cells.length - chartCap) },
  );
}

/**
 * The whole-selection export a linked `explore_corpus` call points at. Reading
 * it re-runs the selection against the snapshot loaded now, so its manifest
 * (provenance included) says which files the export came from.
 */
function registerExportResource(server: Server): void {
  server.registerResource(
    "iwac-export",
    new ResourceTemplate("iwac://export/{mode}/{subset}/{selection}", { list: undefined }),
    {
      title: "IWAC selection export",
      description: "A whole explore_corpus selection as a manifest, CSL-JSON or BibTeX file",
      cacheHint: { ttlMs: 0, cacheScope: "private" },
    },
    async (uri, variables, context) => {
      const { mode, subset, selection: encoded } = variables;
      if (typeof mode !== "string" || !isExportMode(mode)) throw new ProtocolError(INVALID_PARAMS, "Unknown export mode");
      if (typeof subset !== "string" || !(ALL_SUBSETS as string[]).includes(subset))
        throw new ProtocolError(INVALID_PARAMS, "Unknown IWAC dataset subset");
      let decoded: unknown;
      try {
        decoded = JSON.parse(Buffer.from(String(encoded), "base64url").toString("utf8"));
      } catch {
        throw new ProtocolError(INVALID_PARAMS, "The export selection is not valid base64url JSON");
      }
      const parsed = selectionSchema.safeParse(decoded);
      if (!parsed.success) throw new ProtocolError(INVALID_PARAMS, "The export selection does not match explore_corpus");
      return withRequest(context.mcpReq.signal, async () => {
        const selected = subset as Subset;
        const schema = await ensureView(selected),
          v = viewName(selected);
        const f = aggregateFilters(selected, schema, parsed.data);
        if (f.err) throw new ProtocolError(INVALID_PARAMS, String(f.err.error));
        const total = await count(v, f);
        if (total > EXPORT_LINK_MAX)
          throw new ProtocolError(INVALID_PARAMS, `The selection now holds ${total} items, over the ${EXPORT_LINK_MAX}-item export limit`);
        const rows = await exportRows(selected, schema, v, f, EXPORT_LINK_MAX, 0);
        const exported = researchExport(mode as ExportMode, selected, rows, f.echo, { offset: 0, limit: rows.length, total_matches: total });
        return {
          contents: [
            { uri: uri.href, mimeType: exported.mime_type, text: exported.content },
            ...(exported.manifest
              ? [{ uri: `${uri.href}#manifest`, mimeType: "application/json", text: JSON.stringify(exported.manifest, null, 2) }]
              : []),
          ],
        };
      });
    },
  );
}

export function registerResearchTools(server: Server): void {
  registerExportResource(server);
  server.registerTool(
    "explore_corpus",
    {
      title: "Research workbench",
      annotations: annotate(),
      _meta: CHARTS_UI_META,
      description:
        "Selection workbench: items, concordance, coverage, compare (requires comparison), attention, aliases, or paginated manifest/CSL-JSON/BibTeX exports. Exact filters intersect. limit/offset also page compare/coverage/attention cells. Coverage measures archive availability. Exports identify this page and dataset snapshot; compare snapshot IDs across pages. Schema discovery: iwac://datasets/{subset}.",
      inputSchema: z.strictObject({
        mode: z.enum(["items", "concordance", "coverage", "compare", "attention", "aliases", ...EXPORT_MODES]).default("items"),
        subset: z.enum(ALL_SUBSETS as [Subset, ...Subset[]]).default("articles"),
        selection: selectionSchema.optional(),
        comparison: selectionSchema.optional(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(50).default(20),
        link: z.boolean().optional().describe(`Export modes: link the whole selection (≤${EXPORT_LINK_MAX}) as one file instead of a page`),
      }),
      outputSchema: output,
    },
    async ({ mode, subset: requested, selection = {}, comparison, offset, limit, link }) => {
      if (mode === "concordance" && !selection.keyword?.trim())
        return errorResult({ error: "Concordance requires nonempty selection.keyword" });
      const subset = mode === "aliases" ? "index" : requested;
      const schema = await ensureView(subset),
        v = viewName(subset);
      const f = aggregateFilters(subset, schema, selection);
      if (f.err) return errorResult(f.err);
      const total = await count(v, f);
      const base = { subset, filters: f.echo, total_matches: total };
      if (isExportMode(mode) && link) {
        if (total > EXPORT_LINK_MAX)
          return errorResult({
            error: `This selection holds ${total} items; a linked export holds at most ${EXPORT_LINK_MAX}. Narrow it, or page without link.`,
          });
        const uri = exportUri(mode, subset, selection);
        const file = exportFile(mode, subset, "all");
        const result = structuredResult({
          ...base, view: "records", mode, rows: [], export: { ...file, uri, items: total },
          note: "The linked file holds the whole selection, read when the resource is opened; its manifest records the snapshot it was read from.",
        });
        return {
          ...result,
          content: [
            ...result.content,
            { type: "resource_link" as const, uri, name: file.filename, mimeType: file.mime_type, description: `${total} ${subset} items, ${mode}` },
          ],
        };
      }
      if (isExportMode(mode)) {
        const rows = await exportRows(subset, schema, v, f, limit, offset);
        const exported = researchExport(mode, subset, rows, f.echo, { offset, limit, total_matches: total });
        if (Buffer.byteLength(JSON.stringify(exported), "utf8") > 64_000)
          return errorResult({ error: "Export page exceeds 64 kB; reduce limit or narrow selection" });
        return chartResult({
          ...base, view: "records", mode, rows: rows.map(({ id, url, title, date }) => ({ id: String(id), url: String(url), ...(title ? { title: String(title) } : {}), ...(date ? { date: String(date) } : {}) })),
          offset, limit, has_more: offset + rows.length < total, export: exported,
          note: "Export contains this page only. Keep its manifest, and verify matching snapshot IDs when combining pages. Missing citation fields are omitted; author names are literal.",
        });
      }
      const body = bodyColumn(subset, schema);
      const embedding = embeddingColumn(subset);
      const hasEmbedding =
        embedding && schema.has(embedding) ? `${q(embedding)} IS NOT NULL AND len(${q(embedding)}) > 0` : "FALSE";
      const scoredCols = SENTIMENT_MODELS.map((m) => sentimentCols(m).polarity).filter((c) => schema.has(c));
      const scored = scoredCols.length ? scoredCols.map((c) => `(${present(c)})`).join(" OR ") : "FALSE";
      const metrics = `COUNT(*) AS total, ${body ? `COUNT(*) FILTER (WHERE ${present(body)})` : "NULL"} AS fulltext, ${embedding && schema.has(embedding) ? `COUNT(*) FILTER (WHERE ${hasEmbedding})` : "NULL"} AS embedded, ${scoredCols.length ? `COUNT(*) FILTER (WHERE ${scored})` : "NULL"} AS scored`;

      if (mode === "items" || mode === "concordance" || mode === "aliases") {
        if (mode === "concordance" && !body) return errorResult({ error: `No body text column in ${subset}` });
        // Rich KWIC records include both legacy excerpts and sortable contexts.
        // Keep pages within the tool-response budget, and echo the applied page
        // size so clients advance by it without skipping unreturned records.
        const pageLimit = mode === "concordance" ? Math.min(limit, 20) : limit;
        const projection = colsFor(subset, schema, "summary");
        const rows = await query(
          `SELECT ${projection}${mode === "concordance" ? `, ${q(body ?? "")} AS context_text` : ""} FROM ${v} WHERE ${whereSql(f.where)} ORDER BY ${schema.has("pub_date") ? "pub_date DESC NULLS LAST, " : ""}"o:id" LIMIT ? OFFSET ?`,
          [...f.params, pageLimit, offset],
        );
        for (const r of rows) {
          r.id = `${subset}:${r.id}`;
          r.url ||= itemUrl(String(r.id).split(":")[1]);
          if (mode === "concordance") {
            // The contexts follow the selection's own matching rule
            // (aggregateFilters): aliases are whole-phrase alternatives,
            // otherwise each required term gets its contexts.
            const terms = selection.keyword_aliases?.length
              ? [selection.keyword ?? "", ...selection.keyword_aliases]
              : keywordTerms(selection.keyword, selection.keyword_mode);
            Object.assign(r, concordanceContexts(String(r.context_text ?? ""), terms, body ?? ""));
            delete r.context_text;
          }
        }
        return chartResult({
          ...base,
          view: mode === "aliases" ? "aliases" : "records",
          mode,
          rows,
          offset,
          limit: pageLimit,
          has_more: offset + rows.length < total,
          note:
            mode === "aliases"
              ? "Alternate titles are authority suggestions. Choose a term explicitly; expansions can change recall and meaning."
              : mode === "concordance"
                ? "Pages contain at most 20 items and three accent-insensitive literal contexts per item; match_count sums distinct folded terms. UTF-16 source offsets and SHA-256 identify stored text; offsets are omitted when NFC normalization changes the source. Metadata-only hits may have no context."
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
        const selections: ComparisonSelection[] = [];
        const rows: ComparisonRow[] = [];
        for (const [i, filter] of [f, b].entries()) {
          const m = (await query(`SELECT ${metrics} FROM ${v} WHERE ${whereSql(filter.where)}`, filter.params))[0];
          selections.push({ label: i === 0 ? "A" : "B", filters: filter.echo, total: Number(m.total),
            fulltext: m.fulltext === null ? null : Number(m.fulltext),
            embedded: m.embedded === null ? null : Number(m.embedded),
            scored: m.scored === null ? null : Number(m.scored),
          });
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
                  value: String(r.value || "(missing)"),
                  count: Number(r.count),
                  share: Number(m.total) ? Number(r.count) / Number(m.total) : 0,
                })),
              );
            }
        }
        // Rank on the combined base so the two sides always use the same categories,
        // then order the cells by category rank so a page never splits A from B.
        const ranked = new Map<string, number>();
        for (const r of rows) {
          const key = JSON.stringify([r.field, r.value]);
          ranked.set(key, (ranked.get(key) ?? 0) + Number(r.count));
        }
        const order = new Map(
          [...ranked].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key], i) => [key, i]),
        );
        const rank = (r: ComparisonRow) => order.get(JSON.stringify([r.field, r.value])) ?? 0;
        const cells = rows.sort((a, b) => rank(a) - rank(b) || a.selection.localeCompare(b.selection));
        const chartCap = cells.findIndex((r) => rank(r) >= 40);
        return pagedCells(
          {
            ...base,
            view: "comparison",
            selections,
            overlap,
            temporal: await comparisonTimeline(subset, schema, v, selection, comparison),
            note: "Rows are cells (selection × category), ordered by combined category count; page on with offset. Shares use each selection's entire base, including missing values. Categories use stored labels (pipe-joined countries remain one category). Selections can overlap; differences are descriptive, not causal.",
          },
          cells,
          chartCap < 0 ? cells.length : chartCap,
          { offset, limit },
        );
      }
      if (mode === "coverage") {
        if (!schema.has("pub_date")) return errorResult({ error: `No publication date in ${subset}` });
        const source = schema.has("newspaper") ? "newspaper" : schema.has("country") ? "country" : TITLE_COL[subset];
        const rows = await query(
          `SELECT COALESCE(NULLIF(TRIM(${q(source)}), ''), '(missing)') AS source, COALESCE(NULLIF(regexp_extract(pub_date, '^(\\d{4})', 1), ''), '(undated)') AS year, ${metrics} FROM ${v} WHERE ${whereSql(f.where)} GROUP BY 1, 2 ORDER BY total DESC, 1, 2`,
          f.params,
        );
        return pagedCells(
          {
            ...base,
            view: "coverage",
            source_field: source,
            ...(source === "country" ? { source_exact_field: "country_raw" } : {}),
            metrics: {
              fulltext: body ?? "unavailable",
              embedded: embedding && schema.has(embedding) ? embedding : "unavailable",
              scored: scoredCols,
            },
            note: "Cells count archived items, body-text availability, nonempty embeddings and at least one model polarity score, largest first; page on with offset. Availability does not certify OCR or vector quality. Missing dates are explicit; absent cells mean no archived records, not no historical activity. Availability is null when a column is unavailable. Known publication lifetimes are not inferred from archival gaps.",
          },
          rows.map((row) => ({
            source: String(row.source), year: String(row.year), total: Number(row.total),
            fulltext: row.fulltext === null ? null : Number(row.fulltext),
            embedded: row.embedded === null ? null : Number(row.embedded),
            scored: row.scored === null ? null : Number(row.scored),
          })),
          400,
          { offset, limit },
        );
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
      return pagedCells(
        {
          ...base,
          view: "attention",
          note: "Publication-country metadata × mentioned place tags, not routes, migration or information flows. A multi-tagged item can occur in several cells. Denominator is all selected items tagged with that origin country. Cells are ordered by count; page on with offset.",
        },
        rows.map((row) => ({ origin: String(row.origin), destination: String(row.destination), count: Number(row.count), denominator: Number(row.denominator) })),
        200,
        { offset, limit },
      );
    },
  );
}
