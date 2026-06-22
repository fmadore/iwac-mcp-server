import { config, type Subset } from "./config.js";
import { ensureView, query, viewName } from "./db.js";

interface EmbeddingIndex {
  ids: string[];
  matrix: Float32Array; // row-major, normalised; dim = dimensionality
  dim: number;
}

const _indexCache: Map<string, EmbeddingIndex> = new Map();
let _genaiClient: import("@google/genai").GoogleGenAI | null = null;

function requireApiKey(): string {
  if (!config.googleApiKey) {
    throw new Error(
      "Google API key not found. Set IWAC_GOOGLE_API_KEY, GOOGLE_API_KEY, or GEMINI_API_KEY.",
    );
  }
  return config.googleApiKey;
}

function requireSemanticEnabled(): void {
  if (!config.semanticSearchEnabled) {
    throw new Error(
      "Semantic search is not enabled. Enable it in the extension settings (requires a Google/Gemini API key).",
    );
  }
}

async function getClient(): Promise<import("@google/genai").GoogleGenAI> {
  if (_genaiClient) return _genaiClient;
  const apiKey = requireApiKey();
  const { GoogleGenAI } = await import("@google/genai");
  _genaiClient = new GoogleGenAI({ apiKey });
  return _genaiClient;
}

async function loadIndex(subset: Subset, embeddingColumn: string): Promise<EmbeddingIndex> {
  const cacheKey = `${subset}:${embeddingColumn}`;
  const cached = _indexCache.get(cacheKey);
  if (cached) return cached;

  await ensureView(subset);
  console.error(`[iwac] loading ${embeddingColumn} from ${subset}...`);
  const rows = await query(
    `SELECT CAST("o:id" AS VARCHAR) AS id, "${embeddingColumn}" AS emb FROM ${viewName(subset)} WHERE "${embeddingColumn}" IS NOT NULL`,
  );

  const ids: string[] = [];
  const vectors: number[][] = [];
  for (const r of rows) {
    const emb = r.emb as unknown;
    if (!Array.isArray(emb) || emb.length === 0) continue;
    const arr = emb as number[];
    ids.push(String(r.id));
    vectors.push(arr);
  }
  if (ids.length === 0) {
    throw new Error(`No embeddings found in column ${embeddingColumn} of subset ${subset}`);
  }

  const dim = vectors[0].length;
  const matrix = new Float32Array(ids.length * dim);
  for (let i = 0; i < ids.length; i++) {
    const v = vectors[i];
    let norm = 0;
    for (let j = 0; j < dim; j++) norm += v[j] * v[j];
    const invNorm = norm > 0 ? 1 / Math.sqrt(norm) : 0;
    const offset = i * dim;
    for (let j = 0; j < dim; j++) matrix[offset + j] = v[j] * invNorm;
  }

  console.error(`[iwac] semantic index built: ${ids.length} items, dim=${dim}`);
  const idx: EmbeddingIndex = { ids, matrix, dim };
  _indexCache.set(cacheKey, idx);
  return idx;
}

async function embedQuery(text: string): Promise<Float32Array> {
  const client = await getClient();
  const res = await client.models.embedContent({
    model: config.embeddingModel,
    contents: [text],
    config: {
      taskType: "RETRIEVAL_QUERY",
      outputDimensionality: config.embeddingDimensionality,
    },
  });
  const values = res.embeddings?.[0]?.values;
  if (!values || values.length === 0) {
    throw new Error("Gemini returned an empty embedding");
  }
  const v = new Float32Array(values);
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  const invNorm = norm > 0 ? 1 / Math.sqrt(norm) : 0;
  for (let i = 0; i < v.length; i++) v[i] *= invNorm;
  return v;
}

export interface SemanticHit {
  id: string;
  score: number;
}

export async function semanticSearch(opts: {
  subset: Subset;
  embeddingColumn: string;
  query: string;
  limit: number;
  candidateIds?: Iterable<string | number>;
}): Promise<SemanticHit[]> {
  requireSemanticEnabled();
  const idx = await loadIndex(opts.subset, opts.embeddingColumn);
  const q = await embedQuery(opts.query);
  if (q.length !== idx.dim) {
    throw new Error(
      `Query embedding dim ${q.length} does not match index dim ${idx.dim}. Check IWAC_EMBEDDING_MODEL / IWAC_EMBEDDING_DIMENSIONALITY.`,
    );
  }

  const dim = idx.dim;
  let targetIndexes: number[];
  if (opts.candidateIds) {
    const candidateSet = new Set(Array.from(opts.candidateIds, (v) => String(v)));
    targetIndexes = [];
    for (let i = 0; i < idx.ids.length; i++) {
      if (candidateSet.has(idx.ids[i])) targetIndexes.push(i);
    }
  } else {
    targetIndexes = Array.from({ length: idx.ids.length }, (_, i) => i);
  }
  if (targetIndexes.length === 0) return [];

  const scored: SemanticHit[] = [];
  for (const i of targetIndexes) {
    const off = i * dim;
    let s = 0;
    for (let j = 0; j < dim; j++) s += idx.matrix[off + j] * q[j];
    scored.push({ id: idx.ids[i], score: s });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.min(opts.limit, scored.length));
}
