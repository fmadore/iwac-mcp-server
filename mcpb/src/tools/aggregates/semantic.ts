import { chartResult, chartViewResult } from "../shared/chartResults.js";
import { sentimentCols } from "../shared/sentiment.js";
import { isFiniteVector, parseRelated } from "../../vectors.js";
import { z } from "zod";
import { ensureView, q, query, queryOne, type Row, viewName } from "../../db.js";
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
import { aggregateFilters, filterInputs } from "./shared.js";
import { embeddingColumn } from "../../embeddingContract.js";

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
 * Subsets whose stored vectors these tools compare (columns: EMBEDDING_COLUMNS
 * in embeddingContract.ts). Publications are embedded by table of contents and
 * references by abstract, so both maps are sparse by construction; the 30
 * photographs are left to semantic_search_images.
 */
const VECTOR_SUBSETS = ["articles", "documents", "publications", "references"] as const;

/**
 * Calibrated on the EmbeddingGemma 2 vectors upstream (`iwac-analyze
 * similarity-calibration`): at or above this cosine 94% of held-out pairs were
 * lexically confirmed near-duplicates. Unrelated articles already score ~0.7,
 * so lower cutoffs from the earlier Gemini space mean nothing here.
 */
const NEAR_DUPLICATE = 0.97;

/**
 * Upstream publishes each article's and document's ten nearest neighbours as
 * `related_articles` (IWAC-Hugging-Face `post-processing/related_articles.py`),
 * the list islam.zmo.de's "Similar articles" panels show. It ranks the same
 * `embedding_OCR` within the subset by the live query's rule (score
 * descending, ties by string o:id, the row itself excluded), so reading it
 * changes nothing but float noise on four-decimal ties, and makes the server
 * and the site agree by construction. The script can fill publications too,
 * but that list has never been pushed.
 *
 * Upstream nulls the WHOLE column whenever a vector or the row set changes and
 * refills it only on an explicit push: a filled cell is current for its
 * revision, an empty one means "not computed yet", never "no neighbours".
 */
const RELATED_COLUMN = "related_articles";
const RELATED_SUBSETS: readonly Subset[] = ["articles", "documents"];

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
  neighbours_source: z.string(),
  stored_count: z.number(),
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
        subset: z.string().optional().describe("articles (default) | documents | publications | references"),
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
      const subsetV = validateEnum(args.subset, VECTOR_SUBSETS, "subset");
      if (subsetV.err) return errorResult(subsetV.err);
      const subset: Subset = subsetV.canonical ?? "articles";
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
      const embeddingCol = embeddingColumn(subset);
      if (!embeddingCol || !schema.has(embeddingCol)) {
        return errorResult({
          error: `Subset '${subset}' carries no embedding column in this dataset revision`,
          valid_values: [...VECTOR_SUBSETS],
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
      const embCol = q(embeddingCol);
      // Validate/count in DuckDB before crossing the native/JS boundary. A tiny
      // display limit previously still materialised the entire vector corpus.
      // Avoid sum-of-squares: finite extreme values can overflow when squared.
      const validVector = `coalesce(
        len(${embCol}) > 0 AND list_count(${embCol}) = len(${embCol})
        AND list_sum(list_transform(${embCol}, x -> CASE WHEN isfinite(x) THEN 0 ELSE 1 END)) = 0
        AND list_sum(list_transform(${embCol}, x -> CASE WHEN x <> 0 THEN 1 ELSE 0 END)) > 0,
        FALSE)`;
      const counts = await query(
        `SELECT len(${embCol}) AS dim, ${embCol} IS NULL AS missing, ${validVector} AS valid, COUNT(*) AS n
         FROM ${viewName(subset)} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         GROUP BY 1, 2, 3`,
        params,
      );
      const total = counts.reduce((n, r) => n + Number(r.n), 0);
      const missing = counts.filter((r) => r.missing).reduce((n, r) => n + Number(r.n), 0);
      // Keep the established modal-dimension rule and its smaller-dimension tie
      // break, independently of sample ordering or invalid first vectors.
      const modal = counts.filter((r) => r.valid).sort((a, b) => Number(b.n) - Number(a.n) || Number(a.dim) - Number(b.dim))[0];
      const dim = Number(modal?.dim ?? 0);
      const eligible = Number(modal?.n ?? 0);
      const invalid = total - missing - eligible;

      // Deterministic ordering, so the same filter always projects the same
      // items. Only the bounded valid sample is decoded into JS number arrays.
      const titleCol = TITLE_COL[subset];
      const rows = eligible ? await query(
        `SELECT CAST("o:id" AS VARCHAR) AS id, ${q(titleCol)} AS title,
                ${colorBy ? `${q(colorCol as string)} AS grp,` : ""} ${embCol} AS emb
         FROM ${viewName(subset)} WHERE ${[...where, validVector, `len(${embCol}) = ?`].join(" AND ")}
         ORDER BY md5(CAST("o:id" AS VARCHAR) || 'iwac-pca-v1'), "o:id" LIMIT ?`,
        [...params, dim, limit],
      ) : [];

      const kept: Record<string, unknown>[] = [];
      const vectors: number[][] = [];
      for (const r of rows) {
        const emb = r.emb;
        if (!isFiniteVector(emb, dim) || !emb.some((v) => v !== 0))
          return errorResult({ error: "Stored embedding validation disagreed with the selected snapshot" });
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
        missing_embeddings: missing,
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
            `${eligible - kept.length} eligible items omitted by the display limit; ${missing} lack embeddings; ` +
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
        "Nearest stored embeddings by cosine similarity. Articles and documents lead with the dataset's published top 10. Scores run high (unrelated ~0.7) and rank reading candidates; >= 0.97 suggests a near-duplicate, but no threshold proves a reprint. Returns source IDs and dates. Corpus-wide candidate generation belongs offline.",
      _meta: CHARTS_UI_META,
      inputSchema: z.object({
        id: z
          .string()
          .describe("Item id — either a bare o:id ('3064') or the namespaced form search returns ('articles:3064')"),
        subset: z.string().optional().describe("articles (default) | documents | publications | references"),
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

      const askedV = validateEnum(args.subset, VECTOR_SUBSETS, "subset");
      if (askedV.err) return errorResult(askedV.err);
      const subsetV = askedV.canonical ? askedV : validateEnum(subsetFromId, VECTOR_SUBSETS, "subset");
      if (subsetV.err) return errorResult(subsetV.err);
      const subset: Subset = subsetV.canonical ?? "articles";
      if (subsetFromId && askedV.canonical && askedV.canonical !== subsetFromId) {
        return errorResult({
          error: `id '${rawId}' names subset '${subsetFromId}' but subset '${args.subset}' was also given`,
        });
      }
      const schema = await ensureView(subset);
      const embeddingCol = embeddingColumn(subset);
      if (!embeddingCol || !schema.has(embeddingCol)) {
        return errorResult({
          error: `Subset '${subset}' carries no embedding column in this dataset revision`,
          valid_values: [...VECTOR_SUBSETS],
        });
      }
      const id = prefixed ? prefixed[2].trim() : rawId;
      if (!id) return errorResult({ error: "id is required" });
      const limit = Math.max(1, Math.min(50, args.limit ?? 12));

      const titleCol = TITLE_COL[subset];
      const extra = ["newspaper", "pub_date", "country"].filter((c) => schema.has(c));
      const extraSel = extra.length ? `, ${extra.map((c) => q(c)).join(", ")}` : "";
      // Absent from a revision that predates the column, so read it only where
      // the loaded view actually has it.
      const relatedCol = RELATED_SUBSETS.includes(subset) && schema.has(RELATED_COLUMN) ? RELATED_COLUMN : undefined;
      const relatedSel = relatedCol ? `, ${q(relatedCol)} AS related` : "";

      // Resolve the source FIRST. A missing id would otherwise make the target
      // subquery NULL, and `list_inner_product(v, NULL)` returns NULL rather
      // than raising — so every row would come back scored 0 and the tool would
      // present the whole subset as "neighbours" of an item that does not
      // exist. Distinguish the two failures too: a bad id is the caller's, a
      // missing vector is a coverage limit of the public dataset.
      const source = await queryOne(
        `SELECT CAST("o:id" AS VARCHAR) AS id, ${q(titleCol)} AS title,
                ${q(embeddingCol)} IS NOT NULL AS has_vector, ${q(embeddingCol)} AS source_vector${extraSel}${relatedSel}
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

      // The published list first, kept in its stored order with its stored
      // scores. An id the snapshot lacks is dropped: upstream's invalidation
      // rule (see RELATED_COLUMN) means it should never happen, so the note
      // says when it does.
      const listed = relatedCol ? parseRelated(source.related, String(source.id)) : [];
      let stored: Row[] = [];
      if (listed.length) {
        const meta = await query(
          `SELECT CAST("o:id" AS VARCHAR) AS id, ${q(titleCol)} AS title${extraSel}
           FROM ${viewName(subset)} WHERE CAST("o:id" AS VARCHAR) IN (${listed.map(() => "?").join(", ")})`,
          listed.map((n) => n.id),
        );
        const byId = new Map(meta.map((r) => [String(r.id), r]));
        stored = listed.flatMap((n) => {
          const r = byId.get(n.id);
          return r ? [{ ...r, score: n.score }] : [];
        });
      }
      const skipped = listed.length - stored.length;
      stored = stored.slice(0, limit);

      // Past the end of the published list the live ranking continues it. It
      // skips every listed id rather than starting at live rank 11, so a
      // neighbour the two rankings place either side of a tie at the cut is
      // neither lost nor repeated. The stored part is never re-sorted: across
      // that seam a live score can sit above a stored one.
      //
      // MATERIALIZED is load-bearing, not a hint. DuckDB otherwise evaluates
      // list_inner_product before the IS NOT NULL filter, and the row with no
      // vector aborts the whole query with "left argument can not contain NULL
      // values". Materialising the filtered source removes the NULL from the
      // function's input entirely.
      const listedIds = stored.map((r) => String(r.id));
      const notListed = listedIds.length ? ` AND id NOT IN (${listedIds.map(() => "?").join(", ")})` : "";
      const live =
        stored.length < limit
          ? await query(
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
               FROM src WHERE id <> ?${notListed}
               ORDER BY score DESC, id LIMIT ${limit - stored.length}`,
              [id, id, id, ...listedIds],
            )
          : [];

      const min = typeof args.min_score === "number" ? args.min_score : undefined;
      const keep = (rows: Row[]) =>
        rows
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
      const fromStored = keep(stored);
      const fromLive = keep(live);
      const neighbours = [...fromStored, ...fromLive];
      const neighboursSource = !stored.length ? "live" : fromLive.length ? "related_articles+live" : "related_articles";

      const reprints = neighbours.filter((r) => (r.score as number) >= NEAR_DUPLICATE).length;
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
        neighbours_source: neighboursSource,
        stored_count: fromStored.length,
        note:
          `Cosine similarity over the stored embeddings; 1.0 is identical. ` +
          rankingNote(neighboursSource, fromStored.length, skipped, Boolean(relatedCol)) +
          (reprints
            ? `${reprints} neighbour${reprints === 1 ? " scores" : "s score"} at or above ${NEAR_DUPLICATE}, where ` +
              `most pairs in this corpus share their wording: candidates for close reading, not evidence of copying. `
            : `Scores in this embedding space run high (unrelated articles typically ~0.7), so rank matters more than the value. `) +
          `Only items with valid stored vectors of the source dimension can appear; missing vectors restrict recall.`,
      });
    },
  );
}

/**
 * The sentence that says which ranking a neighbour list came from, so a
 * citation can tell the dataset's published list from a live computation.
 */
function rankingNote(source: string, storedCount: number, skipped: number, published: boolean): string {
  const gone = skipped
    ? `${skipped} listed neighbour${skipped === 1 ? " is" : "s are"} absent from this snapshot and ${skipped === 1 ? "was" : "were"} skipped. `
    : "";
  if (source === "related_articles")
    return `Ranked as the dataset publishes it (related_articles, this revision). ${gone}`;
  if (source === "related_articles+live")
    return storedCount
      ? `The first ${storedCount} are the dataset's published ranking (related_articles); the rest are ranked live ` +
          `after them and not re-sorted, so a live score can exceed a stored one. ${gone}`
      : `No neighbour from the dataset's published ranking (related_articles) clears min_score; these continue it live. ${gone}`;
  // Live with a list in hand means every listed id was missing.
  if (skipped)
    return `None of the ${skipped} published neighbour${skipped === 1 ? " is" : "s is"} in this snapshot, so they were ranked live. `;
  return published
    ? "This item has no published neighbour list in this revision, so they were ranked live. "
    : "Ranked live: this subset publishes no neighbour list. ";
}
