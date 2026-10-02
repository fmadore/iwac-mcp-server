import { embeddingContract, validateEmbeddingContract, type EmbeddingContract } from "./embeddingContract.js";
import { requestSignal, requestSnapshots, runSharedWork, waitForSharedWork, WorkQueue } from "./request.js";
import { isFiniteVector, normalizeVector } from "./vectors.js";
import { config, type Subset } from "./config.js";
import { ensureView, q, query, viewGeneration, viewName } from "./db.js";

interface EmbeddingIndex {
  ids: string[];
  matrix: Float32Array; // row-major, normalised; dim = dimensionality
  dim: number;
}

// In-flight PROMISES are memoized (not just resolved indexes) so two concurrent
// first semantic searches share one index build instead of both running the
// full SELECT + matrix normalisation — the same race class getInstance()/ensureView()
// in db.ts document and solve the same way. A failed build is evicted for retry.
// Each entry remembers the view generation it was read from, so an index built
// before a dataset refresh (db.ts) is rebuilt instead of serving vanished ids.
const _indexCache: Map<string, { generation: number; index: Promise<EmbeddingIndex> }> = new Map();
let _genaiClient: import("@google/genai").GoogleGenAI | null = null;

/** Cap on a single Gemini embedContent call — the one network dependency at
 * query time; without it a hung API call blocks the semantic tool forever. */
const EMBED_TIMEOUT_MS = 30_000;
const embeddingQueue = new WorkQueue(4, 16);
const queryCache = new Map<string, Float32Array>();
const pendingQueries = new Map<string, Promise<Float32Array>>();

function requireApiKey(): string {
  if (!config.googleApiKey) {
    throw new Error("Google API key not found. Set IWAC_GOOGLE_API_KEY, GOOGLE_API_KEY, or GEMINI_API_KEY.");
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
  _genaiClient = new GoogleGenAI({ apiKey, httpOptions: { timeout: EMBED_TIMEOUT_MS } });
  return _genaiClient;
}

async function loadIndex(subset: Subset, embeddingColumn: string): Promise<EmbeddingIndex> {
  await ensureView(subset);
  const cacheKey = `${subset}:${embeddingColumn}`;
  const generation = viewGeneration(subset);
  const cached = _indexCache.get(cacheKey);
  if (cached?.generation === generation) return waitForSharedWork(cached.index);
  const index = runSharedWork(() => buildIndex(subset, embeddingColumn), requestSnapshots());
  index.catch(() => {
    if (_indexCache.get(cacheKey)?.index === index) _indexCache.delete(cacheKey); // allow retry after a failed build
  });
  _indexCache.set(cacheKey, { generation, index });
  return waitForSharedWork(index);
}

async function buildIndex(subset: Subset, embeddingColumn: string): Promise<EmbeddingIndex> {
  console.error(`[iwac] loading ${embeddingColumn} from ${subset}...`);
  const rows = await query(
    `SELECT CAST("o:id" AS VARCHAR) AS id, ${q(embeddingColumn)} AS emb FROM ${viewName(subset)} WHERE ${q(embeddingColumn)} IS NOT NULL`,
  );

  // dim comes from the first kept vector; a ragged row (wrong length) is
  // skipped rather than written — one bad row would otherwise fill its matrix
  // slice with NaN and make every sort against it unspecified.
  const ids: string[] = [];
  const vectors: number[][] = [];
  const dim = embeddingContract().dimension;
  let skipped = 0;
  for (const r of rows) {
    const arr = r.emb;
    if (!isFiniteVector(arr, dim) || !arr.some((v) => v !== 0)) {
      skipped++;
      continue;
    }
    ids.push(String(r.id));
    vectors.push(arr);
  }
  if (skipped > 0) {
    console.error(`[iwac] skipped ${skipped} ${subset} invalid embeddings (expected dim ${dim})`);
  }
  if (ids.length === 0) {
    throw new Error(`No embeddings found in column ${embeddingColumn} of subset ${subset}`);
  }

  const matrix = new Float32Array(ids.length * dim);
  for (let i = 0; i < ids.length; i++) {
    matrix.set(normalizeVector(vectors[i]), i * dim);
  }

  console.error(`[iwac] semantic index built: ${ids.length} items, dim=${dim}`);
  return { ids, matrix, dim };
}

async function embedQuery(text: string): Promise<Float32Array> {
  requestSignal()?.throwIfAborted();
  const contract = embeddingContract();
  const cacheKey = JSON.stringify([
    config.embeddingProvider,
    config.localEmbeddingUrl,
    contract,
    text,
  ]);
  const cached = queryCache.get(cacheKey);
  if (cached) return cached;
  let job = pendingQueries.get(cacheKey);
  if (!job) {
    job = runSharedWork(async () => {
      try {
        const vector = await embedUncachedQuery(text, contract);
        queryCache.set(cacheKey, vector);
        if (queryCache.size > 128)
          queryCache.delete(queryCache.keys().next().value as string);
        return vector;
      } finally {
        pendingQueries.delete(cacheKey);
      }
    });
    pendingQueries.set(cacheKey, job);
  }
  return waitForSharedWork(job);
}

async function embedUncachedQuery(
  text: string,
  contract: EmbeddingContract,
): Promise<Float32Array> {
  const release = await embeddingQueue.acquire(requestSignal());
  try {
    const deadline = AbortSignal.timeout(EMBED_TIMEOUT_MS),
      parent = requestSignal();
    const signal = parent ? AbortSignal.any([deadline, parent]) : deadline;
    let values: unknown;
    if (config.embeddingProvider === "local") {
      const url = new URL(config.localEmbeddingUrl);
      if (!["http:", "https:"].includes(url.protocol))
        throw new Error("Local embedding endpoint must use HTTP(S)");
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.localEmbeddingApiKey
            ? { Authorization: `Bearer ${config.localEmbeddingApiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model: contract.model,
          input: [contract.query_prefix + text],
        }),
        signal,
      });
      if (!response.ok)
        throw new Error(
          `Local embedding provider returned HTTP ${response.status}`,
        );
      const data = (await response.json()) as {
        data?: { embedding?: unknown }[];
      };
      values = data.data?.[0]?.embedding;
    } else {
      const client = await getClient();
      const response = await client.models.embedContent({
        model: contract.model,
        contents: [contract.query_prefix + text],
        config: {
          taskType: "RETRIEVAL_QUERY",
          outputDimensionality: contract.dimension,
          abortSignal: signal,
        },
      });
      values = response.embeddings?.[0]?.values;
    }
    if (
      !isFiniteVector(values, contract.dimension) ||
      !values.some((v) => v !== 0)
    )
      throw new Error(
        "Provider returned an invalid, zero or incompatible embedding",
      );
    return normalizeVector(values);
  } finally {
    release();
  }
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
  /** Restrict ranking to these ids. May be a promise, so the caller's SQL
   * prefilter can run while the query is being embedded. */
  candidateIds?: Iterable<string | number> | Promise<Iterable<string | number> | undefined>;
}): Promise<SemanticHit[]> {
  requireSemanticEnabled();
  validateEmbeddingContract(embeddingContract(), opts.subset, opts.embeddingColumn);
  // Three independent waits: the Gemini round-trip, the index (a full column
  // read on first use) and the caller's prefilter. Awaiting them in turn made
  // every search pay the embedding call on top of the other two.
  const [idx, q, candidateIds] = await Promise.all([
    loadIndex(opts.subset, opts.embeddingColumn),
    embedQuery(opts.query),
    opts.candidateIds,
  ]);
  requestSignal()?.throwIfAborted();
  if (q.length !== idx.dim) {
    throw new Error(
      `Query embedding dim ${q.length} does not match index dim ${idx.dim}. Check IWAC_EMBEDDING_MODEL / IWAC_EMBEDDING_DIMENSIONALITY.`,
    );
  }

  const dim = idx.dim;
  let targetIndexes: number[];
  if (candidateIds) {
    const candidateSet = new Set(Array.from(candidateIds, (v) => String(v)));
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
