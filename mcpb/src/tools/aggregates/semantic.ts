import { chartResult, chartViewResult } from "../shared/chartResults.js";
import { sentimentCols } from "../shared/sentiment.js";
import { isFiniteVector } from "../../vectors.js";
import { z } from "zod";
import { ensureView, q, query, queryOne, queryScalarSingle, viewName } from "../../db.js";
import type { Subset } from "../../config.js";
import { projectAsync } from "../../projection.js";
import { createHash } from "node:crypto";
import { limitWarning, resolveLimit } from "../shared/limits.js";
import { viewGeneration } from "../../db.js";
import { CHARTS_UI_META, VIEW } from "../appUi.js";
import {
  codePointBoundary,
  COUNTRIES,
  DEFAULT_SENTIMENT_MODEL,
  errorResult,
  itemUrl,
  TITLE_COL,
  toolMeta,
  validateEnum,
  type Server,
} from "../_shared.js";
import { AGG_SUBSETS, aggregateFilters, filterInputs } from "./shared.js";

/**
 * Fields a semantic scatter may colour by. `polarity` is the stable public name
 * for the default model's polarity column; the raw dataset spelling is aliased
 * onto it so a call written against the column name keeps working.
 *
 * The generation-1 column names are deliberately NOT aliased. They still exist
 * on the Hub, but they hold a different model's reading — accepting
 * `gemini_polarite` here would colour the scatter by one model while the legend
 * says another, which is worse than the self-correcting valid_values error.
 */
const COLOR_FIELDS = ["country", "newspaper", "subject", "lda_topic_label", "polarity"] as const;

const COLOR_ALIASES: Record<string, string> = {
  [sentimentCols(DEFAULT_SENTIMENT_MODEL).polarity]: "polarity",
};

/** The dataset column behind a validated `color_by` value. */
function colorColumn(field: string): string {
  return field === "polarity" ? sentimentCols(DEFAULT_SENTIMENT_MODEL).polarity : field;
}

/**
 * Which column holds each subset's vectors. Publications embed their table of
 * contents rather than their OCR (a whole issue is far past the model's token
 * limit), and only ~31% of them have one, so a publications scatter is sparse
 * by construction.
 */
const EMBEDDING_COLS: Partial<Record<Subset, string>> = {
  articles: "embedding_OCR",
  references: "embedding_OCR",
  publications: "embedding_tableOfContents",
};

/**
 * Titles are the bulk of a semantic-map payload and only ever become a chart
 * tooltip, so they are clipped rather than sent whole.
 */
function clipTitle(value: unknown): string {
  const s = value == null ? "" : String(value).trim();
  return s.length <= 70 ? s : `${s.slice(0, codePointBoundary(s, 69))}…`;
}

const SEMANTIC_MAP_OUTPUT = z.object({
  view: z.string(),
  subset: z.string(),
  filters: z.looseObject({}),
  total_matches: z.number(),
  projected: z.number(),
  eligible_embeddings: z.number().optional(),
  invalid_embeddings: z.number().optional(),
  omitted_by_limit: z.number().optional(),
  missing_embeddings: z.number().optional(),
  sampling: z.string().optional(),
  seed: z.string().optional(),
  requested_limit: z.number().optional(),
  limit_warning: z.string().optional(),
  color_by: z.string().optional(),
  explained_variance: z.array(z.number()),
  // Per-group counts, when color_by is set: the part of a scatter plot a model
  // can actually reason about. The coordinates themselves ride in `_meta` (see
  // `viewResult`), so `points` is absent from the model's copy.
  groups: z.record(z.string(), z.number()).optional(),
  points: z.array(z.looseObject({})).optional(),
  note: z.string(),
});

const SIMILAR_OUTPUT = z.object({
  view: z.string(),
  subset: z.string(),
  source: z.looseObject({}),
  neighbours: z.array(z.looseObject({})),
  note: z.string(),
});

export function registerSemanticTools(server: Server): void {
  // === get_semantic_map ===================================================
  server.registerTool(
    "get_semantic_map",
    {
      ...toolMeta("Semantic scatter"),
      description:
        "Stable-hash sample of matching stored embeddings, projected with PCA. Reports eligible, invalid, missing and capped counts, seed and explained variance. Group counts describe the sample. Coordinates are chart-only; this is not the published UMAP landscape. Needs no API key.",
      _meta: CHARTS_UI_META,
      inputSchema: z.object({
        subset: z.string().optional().describe("articles (default) | publications | references"),
        ...filterInputs(),
        color_by: z
          .string()
          .optional()
          .describe(
            `country | newspaper | subject | lda_topic_label | polarity (${DEFAULT_SENTIMENT_MODEL.id}'s label)`,
          ),
        limit: z.number().int().optional().describe("Items projected (default 300, max 2000)"),
      }),
      outputSchema: SEMANTIC_MAP_OUTPUT,
    },
    async (args) => {
      const subsetV = validateEnum(args.subset, AGG_SUBSETS, "subset");
      if (subsetV.err) return errorResult(subsetV.err);
      const subset = (subsetV.canonical ?? "articles") as Subset;
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);
      const colorRaw = args.color_by?.trim();
      const colorV = validateEnum(
        colorRaw ? (COLOR_ALIASES[colorRaw.toLowerCase()] ?? colorRaw) : colorRaw,
        COLOR_FIELDS,
        "color_by",
      );
      if (colorV.err) return errorResult(colorV.err);

      const schema = await ensureView(subset);
      const embeddingCol = EMBEDDING_COLS[subset];
      if (!embeddingCol || !schema.has(embeddingCol)) {
        return errorResult({
          error: `Subset '${subset}' carries no embedding column in this dataset revision`,
          valid_values: AGG_SUBSETS.filter((s) => EMBEDDING_COLS[s]),
        });
      }
      // `colorBy` is the name echoed back; `colorCol` is the dataset column it
      // reads. They differ for `polarity`, whose column carries the model name.
      const colorCol = colorV.canonical ? colorColumn(colorV.canonical) : undefined;
      const colorBy = colorCol && schema.has(colorCol) ? colorV.canonical : undefined;
      // 2,000 x 768 doubles is ~12 MB and ~1 s of power iteration; past that the
      // scatter is an unreadable smear anyway. The default is deliberately low:
      // every point costs payload, and 300 already fills a 760px frame.
      const cap = resolveLimit(args.limit, 300, 2000);
      const limit = cap.value;

      const filters = aggregateFilters(subset, schema, { ...args, country: country.canonical });
      if (filters.err) return errorResult(filters.err);
      const { where, params, echo } = filters;
      const whereSql = [...where, `${q(embeddingCol)} IS NOT NULL`].join(" AND ");
      const total = Number(
        (await queryScalarSingle<number | bigint>(
          `SELECT COUNT(*) FROM ${viewName(subset)} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`,
          params,
        )) ?? 0,
      );

      // Deterministic ordering, so the same filter always projects the same
      // items — an arbitrary LIMIT would redraw a different map each call.
      const titleCol = TITLE_COL[subset];
      const rows = await query(
        `SELECT CAST("o:id" AS VARCHAR) AS id, ${q(titleCol)} AS title,
                ${colorBy ? `${q(colorCol as string)} AS grp,` : ""} ${q(embeddingCol)} AS emb
         FROM ${viewName(subset)} WHERE ${whereSql}
         ORDER BY md5(CAST("o:id" AS VARCHAR) || 'iwac-pca-v1'), "o:id"`,
        params,
      );

      const kept: Record<string, unknown>[] = [];
      const vectors: number[][] = [];
      let dim = 0;
      let eligible = 0;
      let invalid = 0;
      // Modal dimension is stable even if the first stored vector is corrupt.
      const dimensions = new Map<number, number>();
      for (const r of rows)
        if (isFiniteVector(r.emb) && r.emb.some((v) => v !== 0))
          dimensions.set(r.emb.length, (dimensions.get(r.emb.length) ?? 0) + 1);
      dim = [...dimensions].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 0;
      for (const r of rows) {
        const emb = r.emb;
        if (!isFiniteVector(emb, dim || undefined) || !emb.some((v) => v !== 0)) {
          invalid++;
          continue;
        }
        eligible++;
        if (kept.length >= limit) continue;
        vectors.push(emb);
        kept.push({
          id: String(r.id),
          // Titles are the bulk of this payload and only ever become a chart
          // tooltip, so they are capped rather than sent whole.
          title: clipTitle(r.title),
          ...(colorBy ? { group: r.grp == null ? "" : String(r.grp) } : {}),
        });
      }
      const sampling = {
        eligible_embeddings: eligible,
        invalid_embeddings: invalid,
        missing_embeddings: total - rows.length,
        omitted_by_limit: eligible - kept.length,
        sampling: "stable_hash",
        seed: "iwac-pca-v1",
        ...limitWarning(cap),
      };
      if (!vectors.length) {
        return chartResult({
          view: VIEW.semanticMap,
          subset,
          filters: echo,
          total_matches: total,
          projected: 0,
          ...sampling,
          explained_variance: [0, 0],
          points: [],
          note: "No usable embedding remains after validation in this selection.",
        });
      }

      const key = createHash("sha256")
        .update(JSON.stringify([subset, viewGeneration(subset), dim, kept.map((k) => k.id)]))
        .digest("hex");
      const { points, explained } = await projectAsync(vectors, key);
      // 4 decimals is ~0.01% of a typical axis span: below what any scatter can
      // show, and it keeps a 500-point payload from tripling in size.
      const round = (v: number): number => Math.round(v * 1e4) / 1e4;

      const plotted = kept.map((k, i) => ({ ...k, x: round(points[i][0]), y: round(points[i][1]) }));

      // Per-group counts stand in for the point cloud in the model's copy. A
      // 2-D PCA coordinate is not a fact a model can reason from: it is an
      // artefact of this projection, and the note already says the axes are not
      // the published UMAP landscape. How many items fall in each group IS a
      // fact, and it is the question a reader of the map would ask.
      const groups: Record<string, number> = {};
      if (colorBy) {
        for (const p of plotted) {
          const g = String((p as { group?: string }).group ?? "");
          if (g) groups[g] = (groups[g] ?? 0) + 1;
        }
      }

      // The coordinates go to the chart only: ~11.5k tokens of the ~11.7k this
      // tool used to spend, for data the model cannot read. See viewResult.
      return chartViewResult(
        {
          view: VIEW.semanticMap,
          subset,
          filters: echo,
          total_matches: total,
          projected: kept.length,
          ...sampling,
          ...(colorBy ? { color_by: colorBy, groups } : {}),
          explained_variance: [round(explained[0]), round(explained[1])],
          note:
            `PCA over ${dim}-dimension embeddings, capturing ` +
            `${Math.round((explained[0] + explained[1]) * 100)}% of the variance in these two axes. ` +
            `PCA preserves global spread, not local neighbourhoods, so this is NOT the UMAP semantic landscape ` +
            `published on islam.zmo.de and will not look like it. ` +
            `The ${kept.length} plotted points are rendered in the chart; their coordinates are not repeated here, ` +
            `so cite items from search results rather than from this map. ` +
            `${eligible - kept.length} eligible items omitted by the display limit; ${total - rows.length} lack embeddings; ` +
            `${invalid} have invalid embeddings. Group counts describe the stable-hash sample, not the entire selection.`,
        },
        { points: plotted },
      );
    },
  );

  // === get_similar_items ==================================================
  server.registerTool(
    "get_similar_items",
    {
      ...toolMeta("Find similar items"),
      description:
        "Nearest stored embeddings by cosine similarity, without an API key. Scores rank reading candidates; no threshold proves a reprint. Returns source IDs and dates for comparison. Corpus-wide candidate generation belongs offline.",
      _meta: CHARTS_UI_META,
      inputSchema: z.object({
        id: z
          .string()
          .describe("Item id — either a bare o:id ('3064') or the namespaced form search returns ('articles:3064')"),
        subset: z.string().optional().describe("articles (default) | publications | references"),
        limit: z.number().int().optional().describe("Neighbours returned (default 12, max 50)"),
        min_score: z.number().min(-1).max(1).optional().describe("Minimum cosine similarity (-1 to 1)"),
      }),
      outputSchema: SIMILAR_OUTPUT,
    },
    async (args) => {
      // `search` emits — and `fetch` requires — the namespaced `<subset>:<o:id>`
      // form, so accept it here rather than making the caller strip it: piping a
      // search result straight in is the obvious move and used to fail. The
      // prefix also NAMES the subset, and o:ids are not unique across subsets,
      // so honour it instead of dropping it and looking the number up in the
      // wrong table.
      const rawId = String(args.id ?? "").trim();
      const prefixed = /^([a-z_]+):(.+)$/i.exec(rawId);
      const subsetFromId = prefixed?.[1].toLowerCase();

      const askedV = validateEnum(args.subset, AGG_SUBSETS, "subset");
      if (askedV.err) return errorResult(askedV.err);
      const subsetV = askedV.canonical ? askedV : validateEnum(subsetFromId, AGG_SUBSETS, "subset");
      if (subsetV.err) return errorResult(subsetV.err);
      const subset = (subsetV.canonical ?? "articles") as Subset;
      if (subsetFromId && askedV.canonical && askedV.canonical !== subsetFromId) {
        return errorResult({
          error: `id '${rawId}' names subset '${subsetFromId}' but subset '${args.subset}' was also given`,
        });
      }
      const schema = await ensureView(subset);
      const embeddingCol = EMBEDDING_COLS[subset];
      if (!embeddingCol || !schema.has(embeddingCol)) {
        return errorResult({
          error: `Subset '${subset}' carries no embedding column in this dataset revision`,
          valid_values: AGG_SUBSETS.filter((s) => EMBEDDING_COLS[s]),
        });
      }
      const id = prefixed ? prefixed[2].trim() : rawId;
      if (!id) return errorResult({ error: "id is required" });
      const limit = Math.max(1, Math.min(50, args.limit ?? 12));

      const titleCol = TITLE_COL[subset];
      const extra = ["newspaper", "pub_date", "country"].filter((c) => schema.has(c));
      const extraSel = extra.length ? `, ${extra.map((c) => q(c)).join(", ")}` : "";

      // Resolve the source FIRST. A missing id would otherwise make the target
      // subquery NULL, and `list_inner_product(v, NULL)` returns NULL rather
      // than raising — so every row would come back scored 0 and the tool would
      // present the whole subset as "neighbours" of an item that does not
      // exist. Distinguish the two failures too: a bad id is the caller's, a
      // missing vector is a coverage limit of the public dataset.
      const source = await queryOne(
        `SELECT CAST("o:id" AS VARCHAR) AS id, ${q(titleCol)} AS title,
                ${q(embeddingCol)} IS NOT NULL AS has_vector, ${q(embeddingCol)} AS source_vector${extraSel}
         FROM ${viewName(subset)} WHERE CAST("o:id" AS VARCHAR) = ?`,
        [id],
      );
      if (!source) return errorResult({ error: `No ${subset} item with id ${id}` });
      if (!source.has_vector) {
        return errorResult({
          error:
            `Item ${id} carries no embedding, so stored-vector retrieval cannot find its neighbours.`,
        });
      }

      if (!isFiniteVector(source.source_vector) || !source.source_vector.some((v) => v !== 0))
        return errorResult({ error: `Item ${id} has an invalid or zero embedding` });

      // MATERIALIZED is load-bearing, not a hint. DuckDB otherwise evaluates
      // list_inner_product before the IS NOT NULL filter, and the row with no
      // vector aborts the whole query with "left argument can not contain NULL
      // values". Materialising the filtered source removes the NULL from the
      // function's input entirely.
      const rows = await query(
        `WITH src AS MATERIALIZED (
           SELECT CAST("o:id" AS VARCHAR) AS id, ${q(titleCol)} AS title${extraSel},
                  ${q(embeddingCol)} AS v
           FROM ${viewName(subset)} WHERE ${q(embeddingCol)} IS NOT NULL
             AND len(${q(embeddingCol)}) = (SELECT len(${q(embeddingCol)}) FROM ${viewName(subset)} WHERE CAST("o:id" AS VARCHAR) = ? LIMIT 1)
             AND list_count(${q(embeddingCol)}) = len(${q(embeddingCol)})
             AND len(${q(embeddingCol)}) > 0
             AND list_sum(list_transform(${q(embeddingCol)}, x -> CASE WHEN isfinite(x) THEN 0 ELSE 1 END)) = 0
             AND list_sum(list_transform(${q(embeddingCol)}, x -> x::DOUBLE * x::DOUBLE)) > 0
         ),
         target AS MATERIALIZED (SELECT v FROM src WHERE id = ? LIMIT 1)
         SELECT id, title${extraSel}, list_cosine_similarity(v, (SELECT v FROM target)) AS score
         FROM src WHERE id <> ?
         ORDER BY score DESC, id LIMIT ${limit}`,
        [id, id, id],
      );

      const min = typeof args.min_score === "number" ? args.min_score : undefined;
      const neighbours = rows
        .filter((r) => Number.isFinite(Number(r.score)))
        .map((r) => {
          const rec: Record<string, unknown> = {
            id: String(r.id),
            title: clipTitle(r.title),
            score: Math.round(Number(r.score) * 1e4) / 1e4,
            url: itemUrl(String(r.id)),
          };
          for (const c of extra) if (r[c] != null && String(r[c]).trim() !== "") rec[c] = String(r[c]);
          return rec;
        })
        .filter((r) => min === undefined || (r.score as number) >= min);

      const reprints = neighbours.filter((r) => (r.score as number) >= 0.85).length;
      return chartResult({
        view: VIEW.similar,
        subset,
        source: {
          id: String(source.id),
          title: clipTitle(source.title),
          url: itemUrl(String(source.id)),
          ...Object.fromEntries(extra.map((c) => [c, source[c]])),
        },
        neighbours,
        note:
          `Cosine similarity over the stored embeddings; 1.0 is identical. ` +
          (reprints
            ? `${reprints} neighbour${reprints === 1 ? " scores" : "s score"} at or above 0.85, which in this ` +
              `corpus marks candidates for close reading; it is not evidence of copying. `
            : "") +
          `Only items with valid stored vectors of the source dimension can appear; missing vectors restrict recall.`,
      });
    },
  );
}
