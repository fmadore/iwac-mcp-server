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
  overfetch: number;
}): Promise<SemanticHit[]> {
  requireSemanticEnabled();
  const idx = await loadIndex(opts.subset, opts.embeddingColumn);
  const q = await embedQuery(opts.query);
  if (q.length !== idx.dim) {
    throw new Error(
      `Query embedding dim ${q.length} does not match index dim ${idx.dim}. Check IWAC_EMBEDDING_MODEL / IWAC_EMBEDDING_DIMENSIONALITY.`,
    );
  }

  const n = idx.ids.length;
  const dim = idx.dim;
  const scores = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const off = i * dim;
    let s = 0;
    for (let j = 0; j < dim; j++) s += idx.matrix[off + j] * q[j];
    scores[i] = s;
  }

  const k = Math.min(opts.overfetch, n);
  const top = topKIndices(scores, k);
  return top.map((i) => ({ id: idx.ids[i], score: scores[i] }));
}

/**
 * Indices of the `k` highest scores, sorted descending. Uses a size-`k` min-heap
 * so the scan is O(n log k) with O(k) extra memory, rather than allocating and
 * fully sorting all `n` indices to keep only the top few.
 */
function topKIndices(scores: Float32Array, k: number): number[] {
  const n = scores.length;
  if (k >= n) {
    const all = Array.from({ length: n }, (_, i) => i);
    all.sort((a, b) => scores[b] - scores[a]);
    return all;
  }
  const heap = new Int32Array(k); // root (heap[0]) holds the smallest kept score
  let size = 0;
  const swap = (a: number, b: number) => {
    const t = heap[a];
    heap[a] = heap[b];
    heap[b] = t;
  };
  for (let i = 0; i < n; i++) {
    if (size < k) {
      heap[size] = i;
      let c = size++;
      while (c > 0) {
        const p = (c - 1) >> 1;
        if (scores[heap[c]] >= scores[heap[p]]) break;
        swap(c, p);
        c = p;
      }
    } else if (scores[i] > scores[heap[0]]) {
      heap[0] = i;
      let p = 0;
      while (true) {
        const l = 2 * p + 1;
        const r = 2 * p + 2;
        let smallest = p;
        if (l < size && scores[heap[l]] < scores[heap[smallest]]) smallest = l;
        if (r < size && scores[heap[r]] < scores[heap[smallest]]) smallest = r;
        if (smallest === p) break;
        swap(p, smallest);
        p = smallest;
      }
    }
  }
  const result = Array.from(heap.subarray(0, size));
  result.sort((a, b) => scores[b] - scores[a]);
  return result;
}
