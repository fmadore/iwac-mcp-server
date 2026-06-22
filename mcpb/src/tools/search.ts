// Unified `search` + `fetch` tools implementing the OpenAI Deep Research
// connector contract (https://developers.openai.com/api/docs/mcp):
//
//   search({ query })  ->  { results: [ { id, title, url } ] }
//   fetch({ id })      ->  { id, title, text, url, metadata }
//
// `id` is namespaced as "<subset>:<o:id>" (e.g. "articles:28576") so `fetch`
// can route back to the right subset. These are registered for ALL clients —
// they are the entry point for skill-less clients (ChatGPT) and a convenient
// cross-subset shortcut for everyone else; the richer search_*/get_* tools
// remain available for filtered queries.
import { z } from "zod";
import { ensureView, getById, q, query, selectList, viewName } from "../db.js";
import { ALL_SUBSETS, type Subset } from "../config.js";
import {
  annotate,
  capText,
  errorResult,
  foldedLike,
  resolveLimit,
  textResult,
  type Server,
} from "./_shared.js";

// Subsets the unified `search` spans, in result-interleave priority order.
const SEARCH_SUBSETS: Subset[] = [
  "articles",
  "publications",
  "references",
  "documents",
  "index",
  "audiovisual",
];

interface SubsetSpec {
  /** Column holding the display title (the index subset uses the French "Titre"). */
  titleCol: string;
  /** Columns the query tokens are matched against (OR-ed within a token). */
  textCols: string[];
}

const SPECS: Record<Subset, SubsetSpec> = {
  articles: { titleCol: "title", textCols: ["title", "OCR", "descriptionAI"] },
  publications: { titleCol: "title", textCols: ["title", "subject", "tableOfContents", "OCR"] },
  references: { titleCol: "title", textCols: ["title", "abstract"] },
  documents: { titleCol: "title", textCols: ["title", "OCR", "descriptionAI", "subject"] },
  index: { titleCol: "Titre", textCols: ["Titre", "Titre alternatif", "Description"] },
  audiovisual: { titleCol: "title", textCols: ["title", "creator", "publisher", "subject", "spatial", "language", "source", "descriptionAI"] },
};

/**
 * Build an accent/case-insensitive predicate requiring EVERY query token to
 * appear in at least one of `cols` (tokens AND-ed, columns OR-ed), pushing the
 * bind params in lockstep. This is the crucial difference from the single-value
 * `keyword` filters: a multi-word query like "pèlerinage Mecque" matches items
 * that contain both words anywhere, rather than the literal phrase (which would
 * silently return nothing). Returns false when no usable column/token remains.
 */
function tokenizedWhere(
  schema: Set<string>,
  cols: string[],
  queryStr: string,
  where: string[],
  params: unknown[],
): boolean {
  const present = cols.filter((c) => schema.has(c));
  if (!present.length) return false;
  const tokens = queryStr
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  if (!tokens.length) return false;
  for (const token of tokens) {
    where.push(`(${present.map((c) => foldedLike(q(c))).join(" OR ")})`);
    for (let i = 0; i < present.length; i++) params.push(`%${token}%`);
  }
  return true;
}

interface Hit {
  id: string;
  title: string;
  url: string;
  category: Subset;
}

async function searchSubset(subset: Subset, queryStr: string, limit: number): Promise<Hit[]> {
  const schema = await ensureView(subset);
  const spec = SPECS[subset];
  if (!schema.has("o:id") || !schema.has("iwac_url") || !schema.has(spec.titleCol)) return [];

  const where: string[] = [];
  const params: unknown[] = [];
  if (!tokenizedWhere(schema, spec.textCols, queryStr, where, params)) return [];

  // Rank: most-referenced authority entries first, otherwise newest first.
  const orderBy = schema.has("frequency")
    ? "ORDER BY frequency DESC NULLS LAST"
    : schema.has("pub_date")
      ? "ORDER BY pub_date DESC NULLS LAST"
      : "";
  const rows = await query(
    `SELECT CAST("o:id" AS VARCHAR) AS id, ${q(spec.titleCol)} AS title, iwac_url AS url ` +
      `FROM ${viewName(subset)} WHERE ${where.join(" AND ")} ${orderBy} LIMIT ${limit}`,
    params,
  );
  return rows.map((r) => ({
    id: `${subset}:${String(r.id)}`,
    title: typeof r.title === "string" ? r.title : String(r.title ?? ""),
    url: typeof r.url === "string" ? r.url : String(r.url ?? ""),
    category: subset,
  }));
}

/** Round-robin interleave so every subset is represented, not just the largest. */
function interleave(lists: Hit[][], limit: number): Hit[] {
  const out: Hit[] = [];
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max && out.length < limit; i++) {
    for (const list of lists) {
      if (i < list.length) {
        out.push(list[i]);
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

/**
 * Per-subset detail projection for `fetch`: aliases the title, canonical url,
 * and main text body to stable keys (`title`, `url`, `text`); every other
 * selected column becomes part of `metadata`. Deliberately excludes embedding
 * vectors and lexical-metric columns to keep responses lean.
 */
function detailCols(subset: Subset, schema: Set<string>): string {
  const common: Array<string | [string, string, string[]?]> = [
    ['"o:id"', "id", ["o:id"]],
    ["iwac_url", "url", ["iwac_url"]],
  ];
  switch (subset) {
    case "articles":
      return selectList(schema, [
        ...common,
        "title", "author", "newspaper", "country",
        ["pub_date", "date", ["pub_date"]],
        "subject", "spatial", "language",
        ["gemini_polarite", "polarity", ["gemini_polarite"]],
        ["gemini_centralite_islam_musulmans", "centrality", ["gemini_centralite_islam_musulmans"]],
        ['"descriptionAI"', "description_ai", ["descriptionAI"]],
        ['"OCR"', "text", ["OCR"]],
      ]);
    case "publications":
      return selectList(schema, [
        ...common,
        "title", "newspaper", "country",
        ["pub_date", "date", ["pub_date"]],
        "subject", "language",
        ['"tableOfContents"', "table_of_contents", ["tableOfContents"]],
        ['"OCR"', "text", ["OCR"]],
      ]);
    case "references":
      return selectList(schema, [
        ...common,
        "title", "author", "editor", "type",
        ["pub_date", "date", ["pub_date"]],
        "publisher", "book_title", "volume", "issue", "page_start", "page_end",
        "language", "country", "doi",
        ["abstract", "text", ["abstract"]],
      ]);
    case "documents":
      return selectList(schema, [
        ...common,
        "title", "author", "country",
        ["pub_date", "date", ["pub_date"]],
        "type", "subject", "language",
        ['"descriptionAI"', "description_ai", ["descriptionAI"]],
        ['"OCR"', "text", ["OCR"]],
      ]);
    case "index":
      return selectList(schema, [
        ...common,
        [q("Titre"), "title", ["Titre"]],
        [q("Type"), "type", ["Type"]],
        [q("Description"), "text", ["Description"]],
        "frequency", "first_occurrence", "last_occurrence", "countries",
      ]);
    case "audiovisual":
      return selectList(schema, [
        ...common,
        "title", "creator", "publisher", "country",
        ["pub_date", "date", ["pub_date"]],
        "volume", "issue", "is_part_of", "extent", "medium", "subject", "spatial", "language", "source",
        ["PDF", "media_url", ["PDF"]],
        "iiif_manifest", "thumbnail",
        ['"descriptionAI"', "text", ["descriptionAI"]],
      ]);
  }
  // Unreachable (switch is exhaustive over Subset); satisfies the compiler.
  return selectList(schema, common);
}

/**
 * Honest description of how `search` orders results — there is no relevance
 * score, so we document the actual mechanics (which fields are matched, the
 * round-robin interleave, the per-category tiebreak) rather than inventing one.
 * Returned as the response's `ranking` field so scholarly users can judge the order.
 */
const RANKING_NOTE =
  "Accent/case-insensitive substring match over each item's title + main text " +
  "(articles: OCR + AI abstract; publications: subject + table of contents + OCR; references: abstract; " +
  "documents: OCR + AI description + subject; index: description; audiovisual: AI description). " +
  "Results are interleaved round-robin across categories so each is represented; within a category, " +
  "index entries are ordered by collection frequency and dated items (articles, publications, references, " +
  "documents) newest-first. There is no numeric relevance score — for precise filtering use the search_* tools.";

/** Full-text tools to recommend in `fetch` when an item's text is truncated. */
const FULLTEXT_TOOL: Partial<Record<Subset, { tool: string; idParam: string }>> = {
  articles: { tool: "get_article", idParam: "article_id" },
  publications: { tool: "get_publication_fulltext", idParam: "publication_id" },
  documents: { tool: "get_document", idParam: "document_id" },
};

export function registerSearchTools(server: Server): void {
  // === search (OpenAI Deep Research contract) ==============================
  server.registerTool(
    "search",
    {
      title: "Search IWAC",
      description:
        "Search the Islam West Africa Collection across newspaper articles, Islamic publications, archival " +
        "documents, academic references, and the authority index (persons/places/organisations/events/subjects). " +
        "Pass ONE concept or name — e.g. 'Tijaniyya', 'laïcité', 'Sheikh Gumi', 'pèlerinage'. Matching is accent- " +
        "and case-insensitive; a multi-word query requires every word to appear somewhere in the item, so prefer a " +
        "single concept per call. Write query strings and concept keywords in French for press/publication/document/index discovery even when the user's report " +
        "language is not French. Academic references are multilingual, so try French and English title/abstract terms when relevant; metadata/filter labels remain French. Use the French transliteration of Islamic terms (Tabaski not 'Eid al-Adha', charia " +
        "not 'sharia', Maouloud not 'Mawlid'). Returns {results:[{id,title,url,category}], ranking}; each result's " +
        "`category` names its subset and the `ranking` field documents the ordering. Pass an id to `fetch` to read " +
        "the full text. For filtered queries (by country, date, or newspaper) use the search_* tools instead.",
      annotations: annotate("Search the IWAC collection"),
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("One concept, name, or short phrase; use French concept terms for primary sources, and French/English terms for references"),
        limit: z.number().int().optional().describe("Max results across all categories. Default 20, max 50."),
      },
    },
    async ({ query: queryStr, limit }) => {
      const cap = resolveLimit(limit, 20, 50);
      const lists = await Promise.all(SEARCH_SUBSETS.map((s) => searchSubset(s, queryStr, cap.value)));
      const results = interleave(lists, cap.value);
      const payload: Record<string, unknown> = {
        results,
        count: results.length,
        limit: cap.value,
        ranking: RANKING_NOTE,
      };
      if (cap.capped) {
        payload.requested_limit = cap.requested;
        payload.limit_warning = `Requested limit ${cap.requested} exceeds the maximum ${cap.max}; applied ${cap.value}.`;
      }
      return textResult(payload);
    },
  );

  // === fetch (OpenAI Deep Research contract) ===============================
  server.registerTool(
    "fetch",
    {
      title: "Fetch IWAC item",
      description:
        "Retrieve the full text and metadata of one IWAC item by an id returned from `search` (format " +
        "'<category>:<number>', e.g. 'articles:28576'). Returns {id, title, text, url, metadata}: `text` is the " +
        "item's OCR / abstract / description, `url` is the canonical islam.zmo.de link to cite, and `metadata` " +
        "holds the remaining fields (author, date, country, newspaper, AI sentiment, …). Categories: " +
        "articles, publications, references, documents, index, audiovisual.",
      annotations: annotate("Fetch one IWAC item"),
      inputSchema: {
        id: z.string().describe("Item id from search, e.g. 'articles:28576' or 'references:11045'"),
      },
    },
    async ({ id: rawId }) => {
      const m = /^([a-z_]+):(.+)$/i.exec(rawId.trim());
      if (!m) {
        return errorResult({
          error: `Invalid id '${rawId}'. Expected '<category>:<number>' from search, e.g. 'articles:28576'.`,
          valid_categories: ALL_SUBSETS,
        });
      }
      const subset = m[1].toLowerCase() as Subset;
      const localId = m[2].trim();
      if (!ALL_SUBSETS.includes(subset)) {
        return errorResult({ error: `Unknown category '${subset}'.`, valid_categories: ALL_SUBSETS });
      }

      const schema = await ensureView(subset);
      const row = await getById(subset, detailCols(subset, schema), localId);
      if (!row) {
        return errorResult({
          error: `No ${subset} item with id '${localId}'.`,
          valid_categories: ALL_SUBSETS,
        });
      }

      const title = typeof row.title === "string" ? row.title : String(row.title ?? "");
      const url = typeof row.url === "string" ? row.url : String(row.url ?? "");
      const rawText = typeof row.text === "string" ? row.text : row.text == null ? "" : String(row.text);
      const capped = capText(rawText);
      const text = capped.text.trim() ? capped.text : "(no full text available for this item)";

      const metadata: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        if (k === "title" || k === "url" || k === "text") continue;
        if (v === null || v === undefined) continue;
        if (typeof v === "string" && v.trim() === "") continue;
        metadata[k] = v;
      }

      const result: Record<string, unknown> = { id: rawId, title, text, url, category: subset, metadata };
      // Long OCR is capped here; point the caller at the keyword-excerpt tool for
      // the subset so they can pull just the passages they need instead of re-fetching.
      if (capped.truncated) {
        result.text_truncated = true;
        if (capped.truncation_message) metadata.truncation_message = capped.truncation_message;
        const rec = FULLTEXT_TOOL[subset];
        if (rec) {
          result.recommended_tool = rec.tool;
          result.recommended_usage = {
            [rec.idParam]: /^\d+$/.test(localId) ? Number(localId) : localId,
            keyword: "<your search term>",
          };
        }
      }

      return textResult(result);
    },
  );
}
