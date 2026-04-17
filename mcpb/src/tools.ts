import { z } from "zod";
import {
  ensureView,
  query,
  queryOne,
  queryScalarSingle,
  q,
  selectList,
} from "./db.js";
import { ALL_SUBSETS, type Subset } from "./config.js";
import { semanticSearch } from "./embeddings.js";

// -----------------------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------------------

function annotate(title: string) {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

function capLimit(v: number | undefined, def: number, max: number): number {
  return Math.max(1, Math.min(v ?? def, max));
}

function capOffset(v: number | undefined): number {
  return Math.max(0, v ?? 0);
}

function textResult(payload: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, bigintReplacer, 2) }],
  };
}

function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  return value;
}

interface PaginationEnvelope<T> {
  count: number;
  total_matches: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
  results: T[];
  [key: string]: unknown;
}

async function paginated<T>(
  countSql: string,
  countParams: unknown[],
  pageSql: string,
  pageParams: unknown[],
  offset: number,
  limit: number,
): Promise<PaginationEnvelope<T>> {
  const total = Number((await queryScalarSingle<number | bigint>(countSql, countParams)) ?? 0);
  const results = (await query(pageSql, pageParams)) as unknown as T[];
  const hasMore = offset + limit < total;
  const env: PaginationEnvelope<T> = {
    count: results.length,
    total_matches: total,
    offset,
    has_more: hasMore,
    results,
  };
  if (hasMore) env.next_offset = offset + limit;
  return env;
}

/**
 * Append `col ILIKE ?` to a WHERE list, only if the column exists.
 */
function likeFilterIfExists(
  schema: Set<string>,
  where: string[],
  params: unknown[],
  column: string,
  value: string | undefined,
): void {
  if (!value || !schema.has(column)) return;
  where.push(`${q(column)} ILIKE ?`);
  params.push(`%${value}%`);
}

// Accent-normalise Gemini sentiment labels.
const ACCENT_MAP: Record<string, string> = {
  "tres positif": "Très positif",
  "tres negatif": "Très négatif",
  negatif: "Négatif",
  "tres central": "Très central",
  "non aborde": "Non abordé",
};

function normaliseSentiment(v: string | undefined): string | undefined {
  if (!v) return undefined;
  return ACCENT_MAP[v.toLowerCase()] ?? v;
}

/** Quoted SQL name for a subset view. */
function subsetView(subset: Subset): string {
  return subset === "index" || subset === "references" ? `"${subset}"` : subset;
}

// Column list for article summaries (used by search_articles, search_by_sentiment,
// semantic_search_articles).
function articleSummaryCols(schema: Set<string>): string {
  return selectList(schema, [
    ["\"o:id\"", "o:id", ["o:id"]],
    "title",
    "author",
    "newspaper",
    "country",
    "pub_date",
    "subject",
    "spatial",
    "language",
    "gemini_polarite",
    "gemini_centralite_islam_musulmans",
    "gemini_subjectivite_score",
    ["iwac_url", "url", ["iwac_url"]],
  ]);
}

function publicationSummaryCols(schema: Set<string>): string {
  return selectList(schema, [
    ["\"o:id\"", "o:id", ["o:id"]],
    "title",
    ["COALESCE(\"descriptionAI\", NULL)", "description", ["descriptionAI"]],
    "country",
    ["pub_date", "date", ["pub_date"]],
    "language",
    ["iwac_url", "url", ["iwac_url"]],
  ]);
}

function indexSummaryCols(schema: Set<string>): string {
  return selectList(schema, [
    ["\"o:id\"", "o:id", ["o:id"]],
    "Titre",
    "Type",
    "Description",
    "frequency",
    "first_occurrence",
    "last_occurrence",
    "countries",
    ["iwac_url", "url", ["iwac_url"]],
  ]);
}

// -----------------------------------------------------------------------------
// Tool registration
// -----------------------------------------------------------------------------

export function registerTools(
  server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
): void {
  // === search_articles =====================================================
  server.registerTool(
    "search_articles",
    {
      description:
        "Search IWAC newspaper articles by keyword (title+OCR), country, newspaper, subject, and date range.",
      annotations: annotate("Search newspaper articles"),
      inputSchema: {
        keyword: z.string().optional().describe("Full-text search in title and OCR"),
        country: z.string().optional(),
        newspaper: z.string().optional(),
        subject: z.string().optional(),
        date_from: z.string().optional().describe("YYYY-MM-DD"),
        date_to: z.string().optional().describe("YYYY-MM-DD"),
        limit: z.number().int().optional().describe("Default 20, max 100"),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const schema = await ensureView("articles");
      const limit = capLimit(args.limit, 20, 100);
      const offset = capOffset(args.offset);
      const where: string[] = [];
      const params: unknown[] = [];

      likeFilterIfExists(schema, where, params, "country", args.country);
      likeFilterIfExists(schema, where, params, "newspaper", args.newspaper);
      likeFilterIfExists(schema, where, params, "subject", args.subject);

      if (args.keyword) {
        const parts: string[] = [];
        if (schema.has("title")) {
          parts.push("title ILIKE ?");
          params.push(`%${args.keyword}%`);
        }
        if (schema.has("OCR")) {
          parts.push(`${q("OCR")} ILIKE ?`);
          params.push(`%${args.keyword}%`);
        }
        if (parts.length) where.push(`(${parts.join(" OR ")})`);
      }
      if (args.date_from && schema.has("pub_date")) {
        where.push("pub_date >= CAST(? AS TIMESTAMPTZ)");
        params.push(args.date_from);
      }
      if (args.date_to && schema.has("pub_date")) {
        where.push("pub_date <= CAST(? AS TIMESTAMPTZ)");
        params.push(args.date_to);
      }

      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const cols = articleSummaryCols(schema);
      const orderBy = schema.has("pub_date") ? `ORDER BY pub_date DESC NULLS LAST, "o:id"` : "";
      const countSql = `SELECT COUNT(*) FROM articles ${whereSql}`;
      const pageSql = `SELECT ${cols} FROM articles ${whereSql} ${orderBy} LIMIT ${limit} OFFSET ${offset}`;

      return textResult(await paginated(countSql, params, pageSql, params, offset, limit));
    },
  );

  // === get_article =========================================================
  server.registerTool(
    "get_article",
    {
      description: "Get full metadata and OCR text for an article (by o:id).",
      annotations: annotate("Get article details"),
      inputSchema: {
        article_id: z.number().int(),
      },
    },
    async ({ article_id }) => {
      const schema = await ensureView("articles");
      const cols = selectList(schema, [
        ["\"o:id\"", "id", ["o:id"]],
        "identifier",
        "title",
        "author",
        "newspaper",
        "country",
        "pub_date",
        "subject",
        "spatial",
        "language",
        "nb_pages",
        ["iwac_url", "url", ["iwac_url"]],
        ["\"OCR\"", "ocr_text", ["OCR"]],
        ["nb_mots", "word_count", ["nb_mots"]],
        ["\"Richesse_Lexicale_OCR\"", "lexical_richness", ["Richesse_Lexicale_OCR"]],
        ["\"Lisibilite_OCR\"", "readability", ["Lisibilite_OCR"]],
        ["gemini_centralite_islam_musulmans", "gemini_centrality", ["gemini_centralite_islam_musulmans"]],
        ["gemini_polarite", "gemini_polarity", ["gemini_polarite"]],
        ["gemini_subjectivite_score", "gemini_subjectivity", ["gemini_subjectivite_score"]],
      ]);
      const row = await queryOne(
        `SELECT ${cols} FROM articles WHERE CAST("o:id" AS VARCHAR) = ?`,
        [String(article_id)],
      );
      if (!row) return textResult({ error: `Article ${article_id} not found` });
      return textResult(row);
    },
  );

  // === semantic_search_articles ===========================================
  server.registerTool(
    "semantic_search_articles",
    {
      description:
        "Semantic similarity search over article OCR using Gemini embeddings. Requires semantic search to be enabled and a Google API key.",
      annotations: annotate("Semantic search for articles"),
      inputSchema: {
        query: z.string(),
        country: z.string().optional(),
        newspaper: z.string().optional(),
        date_from: z.string().optional(),
        date_to: z.string().optional(),
        limit: z.number().int().optional().describe("Default 10, max 50"),
      },
    },
    async (args) => {
      const limit = capLimit(args.limit, 10, 50);
      try {
        const hits = await semanticSearch({
          subset: "articles",
          embeddingColumn: "embedding_OCR",
          query: args.query,
          overfetch: limit * 5,
        });
        const schema = await ensureView("articles");
        const cols = articleSummaryCols(schema);
        const filtered: Record<string, unknown>[] = [];
        for (const { id, score } of hits) {
          const row = await queryOne(
            `SELECT ${cols} FROM articles WHERE CAST("o:id" AS VARCHAR) = ?`,
            [String(id)],
          );
          if (!row) continue;
          if (args.country && !ilike(row.country, args.country)) continue;
          if (args.newspaper && !ilike(row.newspaper, args.newspaper)) continue;
          if (args.date_from && !dateGte(row.pub_date, args.date_from)) continue;
          if (args.date_to && !dateLte(row.pub_date, args.date_to)) continue;
          filtered.push({ ...row, similarity_score: Number(score.toFixed(4)) });
          if (filtered.length >= limit) break;
        }
        return textResult({
          query: args.query,
          count: filtered.length,
          filters: {
            country: args.country ?? null,
            newspaper: args.newspaper ?? null,
            date_from: args.date_from ?? null,
            date_to: args.date_to ?? null,
          },
          results: filtered,
        });
      } catch (err) {
        return textResult({ error: String((err as Error).message ?? err) });
      }
    },
  );

  // === semantic_search_publications =======================================
  server.registerTool(
    "semantic_search_publications",
    {
      description:
        "Semantic similarity search over publication tables of contents using Gemini embeddings. Requires semantic search to be enabled and a Google API key.",
      annotations: annotate("Semantic search for publications"),
      inputSchema: {
        query: z.string(),
        country: z.string().optional(),
        limit: z.number().int().optional(),
      },
    },
    async (args) => {
      const limit = capLimit(args.limit, 10, 50);
      try {
        const hits = await semanticSearch({
          subset: "publications",
          embeddingColumn: "embedding_tableOfContents",
          query: args.query,
          overfetch: limit * 5,
        });
        const schema = await ensureView("publications");
        const cols = publicationSummaryCols(schema);
        const tocExpr = schema.has("tableOfContents") ? `, ${q("tableOfContents")}` : "";
        const filtered: Record<string, unknown>[] = [];
        for (const { id, score } of hits) {
          const row = await queryOne(
            `SELECT ${cols}${tocExpr} FROM publications WHERE CAST("o:id" AS VARCHAR) = ?`,
            [String(id)],
          );
          if (!row) continue;
          if (args.country && !ilike(row.country, args.country)) continue;
          const out: Record<string, unknown> = {
            ...row,
            similarity_score: Number(score.toFixed(4)),
          };
          if (!row.tableOfContents) delete out.tableOfContents;
          filtered.push(out);
          if (filtered.length >= limit) break;
        }
        return textResult({
          query: args.query,
          count: filtered.length,
          filters: { country: args.country ?? null },
          results: filtered,
        });
      } catch (err) {
        return textResult({ error: String((err as Error).message ?? err) });
      }
    },
  );

  // === search_by_sentiment =================================================
  server.registerTool(
    "search_by_sentiment",
    {
      description:
        "Filter articles by Gemini sentiment (polarity: Très positif..Très négatif; centrality: Très central..Non abordé).",
      annotations: annotate("Filter articles by AI sentiment"),
      inputSchema: {
        polarity: z.string().optional(),
        centrality: z.string().optional(),
        country: z.string().optional(),
        subject: z.string().optional(),
        limit: z.number().int().optional(),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const schema = await ensureView("articles");
      const limit = capLimit(args.limit, 20, 100);
      const offset = capOffset(args.offset);
      const where: string[] = [];
      const params: unknown[] = [];

      const polarity = normaliseSentiment(args.polarity);
      const centrality = normaliseSentiment(args.centrality);
      if (polarity && schema.has("gemini_polarite")) {
        where.push("gemini_polarite = ?");
        params.push(polarity);
      }
      if (centrality && schema.has("gemini_centralite_islam_musulmans")) {
        where.push("gemini_centralite_islam_musulmans = ?");
        params.push(centrality);
      }
      likeFilterIfExists(schema, where, params, "country", args.country);
      likeFilterIfExists(schema, where, params, "subject", args.subject);

      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const cols = selectList(schema, [
        ["\"o:id\"", "o:id", ["o:id"]],
        "title",
        "newspaper",
        "country",
        "pub_date",
        "gemini_polarite",
        "gemini_centralite_islam_musulmans",
        "gemini_subjectivite_score",
        ["iwac_url", "url", ["iwac_url"]],
      ]);
      const orderBy = schema.has("pub_date") ? `ORDER BY pub_date DESC NULLS LAST, "o:id"` : "";
      const countSql = `SELECT COUNT(*) FROM articles ${whereSql}`;
      const pageSql = `SELECT ${cols} FROM articles ${whereSql} ${orderBy} LIMIT ${limit} OFFSET ${offset}`;
      return textResult(await paginated(countSql, params, pageSql, params, offset, limit));
    },
  );

  // === get_sentiment_distribution =========================================
  server.registerTool(
    "get_sentiment_distribution",
    {
      description: "Aggregate Gemini polarity and centrality counts across a filter set.",
      annotations: annotate("Aggregate AI sentiment"),
      inputSchema: {
        country: z.string().optional(),
        newspaper: z.string().optional(),
        subject: z.string().optional(),
      },
    },
    async (args) => {
      const schema = await ensureView("articles");
      const where: string[] = [];
      const params: unknown[] = [];
      likeFilterIfExists(schema, where, params, "country", args.country);
      likeFilterIfExists(schema, where, params, "newspaper", args.newspaper);
      likeFilterIfExists(schema, where, params, "subject", args.subject);
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      const total = Number(
        (await queryScalarSingle<number | bigint>(
          `SELECT COUNT(*) FROM articles ${whereSql}`,
          params,
        )) ?? 0,
      );
      const payload: Record<string, unknown> = {
        model: "gemini",
        total_articles: total,
        filters: {
          country: args.country ?? null,
          newspaper: args.newspaper ?? null,
          subject: args.subject ?? null,
        },
      };
      if (schema.has("gemini_polarite")) {
        const rows = await query(
          `SELECT gemini_polarite AS k, COUNT(*) AS c FROM articles ${whereSql} GROUP BY gemini_polarite`,
          params,
        );
        payload.polarity_distribution = rowsToMap(rows);
      }
      if (schema.has("gemini_centralite_islam_musulmans")) {
        const rows = await query(
          `SELECT gemini_centralite_islam_musulmans AS k, COUNT(*) AS c FROM articles ${whereSql} GROUP BY gemini_centralite_islam_musulmans`,
          params,
        );
        payload.centrality_distribution = rowsToMap(rows);
      }
      return textResult(payload);
    },
  );

  // === search_index ========================================================
  server.registerTool(
    "search_index",
    {
      description: "Search the IWAC index (persons, places, organisations, events, subjects).",
      annotations: annotate("Search authority index"),
      inputSchema: {
        query: z.string().describe("Search term matched against Titre"),
        index_type: z
          .string()
          .optional()
          .describe("Personnes | Lieux | Organisations | Événements | Sujets"),
        limit: z.number().int().optional(),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const schema = await ensureView("index");
      const limit = capLimit(args.limit, 20, 100);
      const offset = capOffset(args.offset);
      const where: string[] = [`${q("Titre")} ILIKE ?`];
      const params: unknown[] = [`%${args.query}%`];
      if (args.index_type && schema.has("Type")) {
        where.push(`${q("Type")} ILIKE ?`);
        params.push(`%${args.index_type}%`);
      }
      const whereSql = `WHERE ${where.join(" AND ")}`;
      const cols = indexSummaryCols(schema);
      const orderBy = schema.has("frequency")
        ? `ORDER BY frequency DESC NULLS LAST, ${q("Titre")}`
        : `ORDER BY ${q("Titre")}`;
      const countSql = `SELECT COUNT(*) FROM ${subsetView("index")} ${whereSql}`;
      const pageSql = `SELECT ${cols} FROM ${subsetView("index")} ${whereSql} ${orderBy} LIMIT ${limit} OFFSET ${offset}`;
      return textResult(await paginated(countSql, params, pageSql, params, offset, limit));
    },
  );

  // === get_index_entry =====================================================
  server.registerTool(
    "get_index_entry",
    {
      description: "Get full details of an index entry by o:id.",
      annotations: annotate("Get index entry details"),
      inputSchema: { entry_id: z.number().int() },
    },
    async ({ entry_id }) => {
      await ensureView("index");
      const row = await queryOne(
        `SELECT * FROM ${subsetView("index")} WHERE CAST("o:id" AS VARCHAR) = ?`,
        [String(entry_id)],
      );
      if (!row) return textResult({ error: `Index entry ${entry_id} not found` });
      return textResult(row);
    },
  );

  // === list_subjects =======================================================
  registerIndexListTool(server, "list_subjects", "Sujets", false, 50, 200);
  // === list_locations ======================================================
  registerIndexListTool(server, "list_locations", "Lieux", true, 50, 200);
  // === list_persons ========================================================
  registerIndexListTool(server, "list_persons", "Personnes", true, 50, 200);

  // === get_collection_stats ===============================================
  server.registerTool(
    "get_collection_stats",
    {
      description: "Overall statistics for all six IWAC subsets.",
      annotations: annotate("Collection statistics"),
      inputSchema: {},
    },
    async () => {
      const counts: Record<string, number> = {};
      for (const s of ALL_SUBSETS) {
        try {
          await ensureView(s);
          const n = Number(
            (await queryScalarSingle<number | bigint>(
              `SELECT COUNT(*) FROM ${subsetView(s)}`,
            )) ?? 0,
          );
          counts[s] = n;
        } catch {
          counts[s] = 0;
        }
      }
      const schema = await ensureView("articles");
      const payload: Record<string, unknown> = {
        collection_name: "Islam West Africa Collection (IWAC)",
        dataset_url: "https://huggingface.co/datasets/fmadore/islam-west-africa-collection",
        subset_counts: counts,
        total_records: Object.values(counts).reduce((a, b) => a + b, 0),
      };
      if (schema.has("country")) {
        const rows = await query(
          `SELECT country AS k, COUNT(*) AS c FROM articles WHERE country IS NOT NULL GROUP BY country ORDER BY c DESC`,
        );
        payload.articles_by_country = rowsToMap(rows);
      }
      if (schema.has("newspaper")) {
        payload.newspaper_count = Number(
          (await queryScalarSingle<number | bigint>(
            `SELECT COUNT(DISTINCT newspaper) FROM articles WHERE newspaper IS NOT NULL`,
          )) ?? 0,
        );
      }
      if (schema.has("pub_date")) {
        const dateRow = await queryOne(
          `SELECT MIN(pub_date)::VARCHAR AS earliest, MAX(pub_date)::VARCHAR AS latest FROM articles WHERE pub_date IS NOT NULL`,
        );
        payload.date_range = dateRow && dateRow.earliest
          ? {
              earliest: String(dateRow.earliest).slice(0, 10),
              latest: String(dateRow.latest).slice(0, 10),
            }
          : null;
      }
      return textResult(payload);
    },
  );

  // === get_newspaper_stats ================================================
  server.registerTool(
    "get_newspaper_stats",
    {
      description: "Per-newspaper article counts and date ranges.",
      annotations: annotate("Newspaper statistics"),
      inputSchema: { country: z.string().optional() },
    },
    async (args) => {
      const schema = await ensureView("articles");
      const where: string[] = [];
      const params: unknown[] = [];
      likeFilterIfExists(schema, where, params, "country", args.country);
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const hasDate = schema.has("pub_date");
      const dateCols = hasDate
        ? ", MIN(pub_date)::VARCHAR AS earliest_date, MAX(pub_date)::VARCHAR AS latest_date"
        : "";
      const rows = await query(
        `SELECT newspaper, country, COUNT(*) AS article_count${dateCols}
         FROM articles ${whereSql}
         GROUP BY newspaper, country
         ORDER BY article_count DESC`,
        params,
      );
      const total = Number(
        (await queryScalarSingle<number | bigint>(
          `SELECT COUNT(*) FROM articles ${whereSql}`,
          params,
        )) ?? 0,
      );
      return textResult({
        country_filter: args.country ?? null,
        total_newspapers: rows.length,
        total_articles: total,
        newspapers: rows,
      });
    },
  );

  // === get_country_comparison ============================================
  server.registerTool(
    "get_country_comparison",
    {
      description:
        "Compare article counts, newspaper counts, date ranges, and Gemini polarity across countries.",
      annotations: annotate("Compare countries"),
      inputSchema: {},
    },
    async () => {
      const schema = await ensureView("articles");
      if (!schema.has("country")) return textResult({ total_countries: 0, countries: [] });

      const dateSel = schema.has("pub_date")
        ? ", MIN(pub_date)::VARCHAR AS earliest, MAX(pub_date)::VARCHAR AS latest"
        : "";
      const newsSel = schema.has("newspaper")
        ? ", COUNT(DISTINCT newspaper) AS newspaper_count"
        : "";
      const summary = await query(`
        SELECT country, COUNT(*) AS article_count${newsSel}${dateSel}
        FROM articles
        WHERE country IS NOT NULL
        GROUP BY country
        ORDER BY article_count DESC
      `);

      const polarityByCountry = new Map<string, Record<string, number>>();
      if (schema.has("gemini_polarite")) {
        const rows = await query(`
          SELECT country, gemini_polarite AS k, COUNT(*) AS c
          FROM articles
          WHERE country IS NOT NULL
          GROUP BY country, gemini_polarite
        `);
        for (const r of rows) {
          const c = String(r.country);
          const bucket = polarityByCountry.get(c) ?? {};
          if (r.k != null) bucket[String(r.k)] = Number(r.c);
          polarityByCountry.set(c, bucket);
        }
      }

      const countries = summary.map((r) => {
        const c = String(r.country);
        const rec: Record<string, unknown> = {
          country: c,
          article_count: Number(r.article_count),
        };
        if (schema.has("newspaper")) rec.newspaper_count = Number(r.newspaper_count);
        if (schema.has("pub_date") && r.earliest) {
          rec.date_range = {
            earliest: String(r.earliest).slice(0, 10),
            latest: String(r.latest).slice(0, 10),
          };
        }
        const pol = polarityByCountry.get(c);
        if (pol && Object.keys(pol).length) rec.gemini_polarity = pol;
        return rec;
      });
      return textResult({ total_countries: countries.length, countries });
    },
  );

  // === search_publications ================================================
  server.registerTool(
    "search_publications",
    {
      description:
        "Search Islamic publications (books, periodicals). When the keyword matches the table of contents, only matching TOC entries are returned.",
      annotations: annotate("Search publications"),
      inputSchema: {
        keyword: z.string().optional(),
        country: z.string().optional(),
        limit: z.number().int().optional(),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const schema = await ensureView("publications");
      const limit = capLimit(args.limit, 20, 100);
      const offset = capOffset(args.offset);

      const where: string[] = [];
      const params: unknown[] = [];
      if (args.keyword) {
        const parts: string[] = [];
        const kw = `%${args.keyword}%`;
        if (schema.has("title")) {
          parts.push("title ILIKE ?");
          params.push(kw);
        }
        if (schema.has("descriptionAI")) {
          parts.push(`${q("descriptionAI")} ILIKE ?`);
          params.push(kw);
        }
        if (schema.has("tableOfContents")) {
          parts.push(`${q("tableOfContents")} ILIKE ?`);
          params.push(kw);
        }
        if (parts.length) where.push(`(${parts.join(" OR ")})`);
      }
      likeFilterIfExists(schema, where, params, "country", args.country);
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      const cols = publicationSummaryCols(schema);
      const tocExpr = args.keyword && schema.has("tableOfContents") ? `, ${q("tableOfContents")}` : "";
      const orderBy = schema.has("pub_date") ? `ORDER BY pub_date DESC NULLS LAST, "o:id"` : "";
      const countSql = `SELECT COUNT(*) FROM publications ${whereSql}`;
      const pageSql = `SELECT ${cols}${tocExpr} FROM publications ${whereSql} ${orderBy} LIMIT ${limit} OFFSET ${offset}`;

      const env = await paginated<Record<string, unknown>>(
        countSql,
        params,
        pageSql,
        params,
        offset,
        limit,
      );
      if (args.keyword) {
        for (const r of env.results) {
          const toc = r.tableOfContents ? String(r.tableOfContents) : "";
          const matching = extractMatchingTocEntries(toc, args.keyword);
          delete r.tableOfContents;
          if (matching) r.matching_toc_entries = matching;
        }
      }
      return textResult(env);
    },
  );

  // === get_publication_fulltext ===========================================
  server.registerTool(
    "get_publication_fulltext",
    {
      description:
        "Full OCR text of a publication, optionally returning ~2000-char excerpts around each keyword match.",
      annotations: annotate("Get publication full text"),
      inputSchema: {
        publication_id: z.number().int(),
        keyword: z.string().optional(),
        context_chars: z.number().int().optional().describe("Default 2000, max 5000"),
      },
    },
    async (args) => {
      const schema = await ensureView("publications");
      const cols = selectList(schema, [
        ["\"o:id\"", "id", ["o:id"]],
        "title",
        "tableOfContents",
        ["\"OCR\"", "fulltext", ["OCR"]],
      ]);
      const row = await queryOne(
        `SELECT ${cols} FROM publications WHERE "o:id" = ?`,
        [args.publication_id],
      );
      if (!row) return textResult({ error: `Publication ${args.publication_id} not found` });

      const result: Record<string, unknown> = {
        "o:id": args.publication_id,
        title: row.title ?? "",
      };
      if (row.tableOfContents) result.tableOfContents = row.tableOfContents;

      const ocr = (row.fulltext as string | null) ?? "";
      if (!ocr) {
        result.fulltext = null;
        result.note = "No OCR text available for this publication";
        return textResult(result);
      }
      if (!args.keyword) {
        result.fulltext = ocr;
        result.char_count = ocr.length;
        return textResult(result);
      }
      const contextChars = Math.min(args.context_chars ?? 2000, 5000);
      const half = Math.floor(contextChars / 2);
      const lower = ocr.toLowerCase();
      const kw = args.keyword.toLowerCase();
      const excerpts: string[] = [];
      let pos = 0;
      while (true) {
        const idx = lower.indexOf(kw, pos);
        if (idx === -1) break;
        const start = Math.max(0, idx - half);
        const end = Math.min(ocr.length, idx + args.keyword.length + half);
        let ex = ocr.slice(start, end);
        if (start > 0) ex = "..." + ex;
        if (end < ocr.length) ex += "...";
        excerpts.push(ex);
        pos = idx + args.keyword.length;
      }
      if (excerpts.length === 0) {
        result.excerpts = [];
        result.note = `Keyword '${args.keyword}' not found in full text`;
      } else {
        result.excerpts = excerpts;
        result.match_count = excerpts.length;
      }
      return textResult(result);
    },
  );

  // === search_references ==================================================
  server.registerTool(
    "search_references",
    {
      description: "Search academic references (journal articles, books, theses) by title and abstract.",
      annotations: annotate("Search academic references"),
      inputSchema: {
        keyword: z.string().optional(),
        author: z.string().optional(),
        reference_type: z.string().optional(),
        limit: z.number().int().optional(),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const schema = await ensureView("references");
      const limit = capLimit(args.limit, 20, 100);
      const offset = capOffset(args.offset);
      const where: string[] = [];
      const params: unknown[] = [];

      if (args.keyword) {
        const parts: string[] = [];
        const kw = `%${args.keyword}%`;
        if (schema.has("title")) {
          parts.push("title ILIKE ?");
          params.push(kw);
        }
        if (schema.has("abstract")) {
          parts.push("abstract ILIKE ?");
          params.push(kw);
        }
        if (parts.length) where.push(`(${parts.join(" OR ")})`);
      }
      likeFilterIfExists(schema, where, params, "author", args.author);
      likeFilterIfExists(schema, where, params, "type", args.reference_type);
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      const cols = selectList(schema, [
        ["\"o:id\"", "o:id", ["o:id"]],
        "title",
        "author",
        "type",
        ["pub_date", "date", ["pub_date"]],
        "publisher",
        ["iwac_url", "url", ["iwac_url"]],
      ]);
      const orderBy = schema.has("pub_date") ? `ORDER BY pub_date DESC NULLS LAST, "o:id"` : "";
      const countSql = `SELECT COUNT(*) FROM ${subsetView("references")} ${whereSql}`;
      const pageSql = `SELECT ${cols} FROM ${subsetView("references")} ${whereSql} ${orderBy} LIMIT ${limit} OFFSET ${offset}`;
      return textResult(await paginated(countSql, params, pageSql, params, offset, limit));
    },
  );

  // === list_audiovisual ====================================================
  server.registerTool(
    "list_audiovisual",
    {
      description: "List audiovisual materials.",
      annotations: annotate("List audiovisual materials"),
      inputSchema: {
        country: z.string().optional(),
        limit: z.number().int().optional(),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const schema = await ensureView("audiovisual");
      const limit = capLimit(args.limit, 20, 50);
      const offset = capOffset(args.offset);
      const where: string[] = [];
      const params: unknown[] = [];
      likeFilterIfExists(schema, where, params, "country", args.country);
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      const cols = selectList(schema, [
        ["\"o:id\"", "o:id", ["o:id"]],
        "title",
        "country",
        ["pub_date", "date", ["pub_date"]],
        ["\"descriptionAI\"", "description", ["descriptionAI"]],
        "language",
        ["iwac_url", "url", ["iwac_url"]],
      ]);
      const orderBy = schema.has("pub_date") ? `ORDER BY pub_date DESC NULLS LAST, "o:id"` : "";
      const countSql = `SELECT COUNT(*) FROM audiovisual ${whereSql}`;
      const pageSql = `SELECT ${cols} FROM audiovisual ${whereSql} ${orderBy} LIMIT ${limit} OFFSET ${offset}`;
      return textResult(await paginated(countSql, params, pageSql, params, offset, limit));
    },
  );
}

// -----------------------------------------------------------------------------
// Generic index list tool
// -----------------------------------------------------------------------------

function registerIndexListTool(
  server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
  name: "list_subjects" | "list_locations" | "list_persons",
  indexType: string,
  withCountry: boolean,
  defaultLimit: number,
  maxLimit: number,
): void {
  const inputSchema: Record<string, z.ZodTypeAny> = {
    limit: z.number().int().optional(),
    offset: z.number().int().optional(),
  };
  if (withCountry) inputSchema.country = z.string().optional();

  server.registerTool(
    name,
    {
      description: `List ${indexType.toLowerCase()} from the IWAC index, sorted by frequency.`,
      annotations: annotate(`List ${indexType.toLowerCase()} from the index`),
      inputSchema,
    },
    async (args: Record<string, unknown>) => {
      const schema = await ensureView("index");
      const limit = capLimit(args.limit as number | undefined, defaultLimit, maxLimit);
      const offset = capOffset(args.offset as number | undefined);
      const where: string[] = [`${q("Type")} = ?`];
      const params: unknown[] = [indexType];
      if (withCountry) {
        likeFilterIfExists(schema, where, params, "countries", args.country as string | undefined);
      }
      const whereSql = `WHERE ${where.join(" AND ")}`;
      const cols = selectList(schema, [
        ["\"o:id\"", "o:id", ["o:id"]],
        "Titre",
        "Description",
        "frequency",
        ...(withCountry ? (["countries"] as const) : []),
        ["iwac_url", "url", ["iwac_url"]],
      ]);
      const orderBy = schema.has("frequency")
        ? `ORDER BY frequency DESC NULLS LAST, ${q("Titre")}`
        : `ORDER BY ${q("Titre")}`;
      const countSql = `SELECT COUNT(*) FROM ${subsetView("index")} ${whereSql}`;
      const pageSql = `SELECT ${cols} FROM ${subsetView("index")} ${whereSql} ${orderBy} LIMIT ${limit} OFFSET ${offset}`;
      return textResult(await paginated(countSql, params, pageSql, params, offset, limit));
    },
  );
}

// -----------------------------------------------------------------------------
// Small utilities
// -----------------------------------------------------------------------------

function ilike(haystack: unknown, needle: string): boolean {
  if (haystack == null) return false;
  return String(haystack).toLowerCase().includes(needle.toLowerCase());
}

function dateGte(value: unknown, iso: string): boolean {
  if (value == null) return false;
  const v = new Date(String(value)).getTime();
  const b = new Date(iso).getTime();
  return Number.isFinite(v) && Number.isFinite(b) && v >= b;
}

function dateLte(value: unknown, iso: string): boolean {
  if (value == null) return false;
  const v = new Date(String(value)).getTime();
  const b = new Date(iso).getTime();
  return Number.isFinite(v) && Number.isFinite(b) && v <= b;
}

function rowsToMap(rows: Record<string, unknown>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.k == null) continue;
    out[String(r.k)] = Number(r.c);
  }
  return out;
}

function extractMatchingTocEntries(toc: string, keyword: string): string {
  if (!toc || !keyword) return "";
  const kw = keyword.toLowerCase();
  const entries = toc.split(/\n\n+/).map((s) => s.trim()).filter(Boolean);
  return entries.filter((e) => e.toLowerCase().includes(kw)).join("\n\n");
}
