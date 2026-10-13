import {
  embeddingContract,
  validateEmbeddingContract,
  verifyCorpusAnchors,
  verifyProbeVector,
  type EmbeddingContract,
} from "./embeddingContract.js";
import { encodeQuery, ENCODER_MODEL, encoderReady } from "./onnxEncoder.js";
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

/** Cap on one call to a `local` embedding endpoint; without it a hung server
 * blocks the semantic tool forever. The in-process encoder needs none. */
const EMBED_TIMEOUT_MS = 30_000;
const embeddingQueue = new WorkQueue(4, 16);
const queryCache = new Map<string, Float32Array>();
const pendingQueries = new Map<string, Promise<Float32Array>>();

function requireSemanticEnabled(): void {
  if (!config.semanticSearchEnabled) {
    throw new Error("Semantic search is not enabled (IWAC_SEMANTIC_SEARCH_ENABLED=false).");
  }
}

/** Refuse any provider that cannot produce the corpus's vectors, by name. */
function requireProvider(contract: EmbeddingContract): void {
  const provider = config.embeddingProvider;
  if (provider === "gemini") {
    throw new Error(
      "Gemini query embeddings were retired in v4.0.0: since dataset revision d834ab71 the corpus vectors are " +
        "EmbeddingGemma 2, which this server runs locally without an API key. Unset IWAC_EMBEDDING_PROVIDER.",
    );
  }
  if (provider !== "onnx" && provider !== "local") {
    throw new Error(`Unknown IWAC_EMBEDDING_PROVIDER '${provider}'; use onnx (the default) or local.`);
  }
  if (provider === "onnx" && contract.model !== ENCODER_MODEL) {
    throw new Error(
      `The corpus contract names ${contract.model}, but the in-process encoder runs ${ENCODER_MODEL}. ` +
        "Serve that model through IWAC_EMBEDDING_PROVIDER=local instead.",
    );
  }
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
    // Vectors of another width are another model's, whatever the column says.
    throw new Error(
      skipped
        ? `The ${subset} vectors in this dataset revision are not ${embeddingContract().model} vectors: ` +
            `none of ${skipped} has its ${dim} dimensions. Semantic search is refused.`
        : `No embeddings found in column ${embeddingColumn} of subset ${subset}`,
    );
  }

  const matrix = new Float32Array(ids.length * dim);
  for (let i = 0; i < ids.length; i++) {
    matrix.set(normalizeVector(vectors[i]), i * dim);
  }
  // A column from another model, or from a revision before the re-embed, would
  // still load and rank: check the vectors themselves before serving any.
  verifyCorpusAnchors(embeddingContract(), subset, (id) => {
    const i = ids.indexOf(id);
    return i < 0 ? undefined : matrix.subarray(i * dim, (i + 1) * dim);
  });

  console.error(`[iwac] semantic index built: ${ids.length} items, dim=${dim}`);
  return { ids, matrix, dim };
}

/** Everything that decides which vector a query text becomes. */
function encoderKey(contract: EmbeddingContract): string {
  return JSON.stringify([
    config.embeddingProvider,
    config.embeddingProvider === "local" ? config.localEmbeddingUrl : config.embeddingDtype,
    config.modelCacheDir,
    contract.model,
    contract.revision,
    contract.query_prefix,
  ]);
}

let probeCheck: { key: string; done: Promise<void> } | undefined;

/**
 * Check once per encoder configuration that it reproduces the contract's
 * reference vector for the probe query (embeddingContract.ts). The check is
 * process-owned shared work, like the encoder it tests, so a caller that gives
 * up does not fail it for the others; a failed check is forgotten and retried.
 */
function verifyEncoder(contract: EmbeddingContract): Promise<void> {
  const probe = contract.probe;
  if (!probe) return Promise.resolve();
  const key = encoderKey(contract);
  if (probeCheck?.key !== key) {
    const done = runSharedWork(async () => verifyProbeVector(contract, await embedQuery(probe.query)));
    probeCheck = { key, done };
    done.catch(() => {
      if (probeCheck?.done === done) probeCheck = undefined;
    });
  }
  return waitForSharedWork(probeCheck.done);
}

async function embedQuery(text: string): Promise<Float32Array> {
  requestSignal()?.throwIfAborted();
  const contract = embeddingContract();
  const cacheKey = JSON.stringify([encoderKey(contract), text]);
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
  // The first search may wait minutes for the encoder's one-time download;
  // that wait must not hold one of the few slots every other search queues for.
  if (config.embeddingProvider === "onnx") await encoderReady();
  const release = await embeddingQueue.acquire(requestSignal());
  try {
    let values: unknown;
    if (config.embeddingProvider === "onnx") {
      values = await encodeQuery(contract.query_prefix + text);
    } else {
      const deadline = AbortSignal.timeout(EMBED_TIMEOUT_MS),
        parent = requestSignal();
      const signal = parent ? AbortSignal.any([deadline, parent]) : deadline;
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
  const contract = embeddingContract();
  requireProvider(contract);
  validateEmbeddingContract(contract, opts.subset, opts.embeddingColumn);
  // Independent waits: the query encoding and the check of the encoder, the
  // index (a full column read and anchor check on first use) and the caller's
  // prefilter. Awaiting them in turn made every search pay for each in sequence.
  const [idx, , q, candidateIds] = await Promise.all([
    loadIndex(opts.subset, opts.embeddingColumn),
    verifyEncoder(contract),
    embedQuery(opts.query),
    opts.candidateIds,
  ]);
  requestSignal()?.throwIfAborted();
  if (q.length !== idx.dim) {
    throw new Error(`Query embedding dim ${q.length} does not match index dim ${idx.dim}.`);
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
