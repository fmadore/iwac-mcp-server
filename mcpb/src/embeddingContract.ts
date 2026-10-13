import * as fs from "node:fs";
import { z } from "zod";
import { config, type Subset } from "./config.js";
import { CORPUS_PROBE } from "./embeddingProbe.js";

/**
 * Which column holds each subset's vectors in the published dataset. One map
 * for every consumer: the semantic_search_* tools, get_similar_items,
 * get_semantic_map and the coverage counts. Publications embed their table of
 * contents (a whole issue is far past the model's context), references their
 * title + abstract (their full texts are book-length), images the photograph.
 */
export const EMBEDDING_COLUMNS = {
  articles: "embedding_OCR",
  documents: "embedding_OCR",
  publications: "embedding_tableOfContents",
  references: "embedding_abstract",
  images: "embedding_image",
} as const satisfies Partial<Record<Subset, string>>;

/** The vector column of `subset`, if it has one. */
export function embeddingColumn(subset: Subset): string | undefined {
  return (EMBEDDING_COLUMNS as Partial<Record<Subset, string>>)[subset];
}

const anchor = z.object({ subset: z.string(), id: z.string().min(1), cosine: z.number().min(-1).max(1) });
const schema = z
  .object({
    model: z.string().min(1),
    revision: z.string().min(1),
    dimension: z.number().int().min(1).max(8192),
    normalization: z.enum(["unit-l2", "none"]),
    // A contract either pins one immutable dataset commit…
    dataset_revision: z.string().regex(/^[a-f0-9]{40}$/i).optional(),
    fields: z.record(z.string(), z.string().min(1)),
    query_prefix: z.string().default(""),
    // …or carries the evidence to check any revision: the reference encoder's
    // vector for one query, and that vector's cosine to a few stored items.
    probe: z.object({ query: z.string().min(1), vector: z.string().min(1) }).optional(),
    anchors: z.array(anchor).optional(),
    anchors_dataset_revision: z.string().optional(),
  })
  .refine((c) => c.dataset_revision || (c.probe && c.anchors?.length), {
    message: "An embedding contract must pin dataset_revision or carry a probe and anchors",
  });
export type EmbeddingContract = z.infer<typeof schema>;

/**
 * The public corpus since dataset revision d834ab71: every vector column was
 * regenerated with EmbeddingGemma 2 from its pinned fp32 ONNX export
 * (IWAC-Hugging-Face e79cb11). There is no "published-default" revision any
 * more: that escape hatch is what let a model change through unnoticed, since
 * names alone cannot prove two vector spaces are the same. The server checks
 * the vectors instead: its query encoder against the probe, and each loaded
 * column against the anchors. A corpus re-embedded with another model, or an
 * older revision pinned with IWAC_DATASET_REVISION, is refused rather than
 * ranked.
 */
const PUBLISHED: EmbeddingContract = {
  model: "google/embeddinggemma-2",
  revision: "914f7f89142e33e77833254d9c9b90c3cef7303b",
  dimension: 768,
  normalization: "unit-l2",
  fields: { ...EMBEDDING_COLUMNS },
  query_prefix: "task: search result | query: ",
  probe: { query: CORPUS_PROBE.query, vector: CORPUS_PROBE.vector },
  anchors: CORPUS_PROBE.anchors.map((a) => ({ ...a })),
  anchors_dataset_revision: CORPUS_PROBE.anchors_dataset_revision,
};

/** Cosine the query encoder must reach against the reference probe vector:
 * the parity bar the q8 export clears (measured >= 0.99994). */
export const PROBE_MIN_COSINE = 0.999;
/** Allowed drift of a stored anchor's cosine to the probe. Both sides are
 * fp32 reference values, so this only absorbs float storage noise. */
const ANCHOR_TOLERANCE = 1e-3;

let loaded: EmbeddingContract | undefined;
export function embeddingContract(): EmbeddingContract {
  if (loaded) return loaded;
  const file = process.env.IWAC_EMBEDDING_CONTRACT_FILE?.trim();
  loaded = file ? schema.parse(JSON.parse(fs.readFileSync(file, "utf8"))) : PUBLISHED;
  return loaded;
}

/** What provenance records about the contract: its identity, not the probe
 * vector (4 kB of base64 on every response would buy the reader nothing). */
export function contractSummary(contract = embeddingContract()): Record<string, unknown> {
  const { probe, anchors, ...identity } = contract;
  return {
    ...identity,
    ...(probe ? { probe_query: probe.query } : {}),
    ...(anchors ? { anchors: anchors.length } : {}),
    encoder: {
      provider: config.embeddingProvider,
      ...(config.embeddingProvider === "onnx" ? { dtype: config.embeddingDtype } : {}),
    },
  };
}

export function validateEmbeddingContract(contract: EmbeddingContract, subset: Subset, column: string): void {
  if (contract.fields[subset] !== column) {
    throw new Error(
      `The embedding contract has no ${column} vectors for ${subset}; the query cannot be ranked against them.`,
    );
  }
  if (config.embeddingModel !== undefined && config.embeddingModel !== contract.model) {
    throw new Error(
      `IWAC_EMBEDDING_MODEL is ${config.embeddingModel}, but the corpus vectors are ${contract.model}. ` +
        "Equal dimensions do not imply compatible embedding spaces; unset it or match the corpus.",
    );
  }
  if (config.embeddingDimensionality !== undefined && config.embeddingDimensionality !== contract.dimension) {
    throw new Error(
      `IWAC_EMBEDDING_DIMENSIONALITY is ${config.embeddingDimensionality}, but the corpus vectors have ${contract.dimension} dimensions.`,
    );
  }
  if (contract.dataset_revision && contract.dataset_revision !== config.datasetRevision)
    throw new Error("Embedding contract dataset_revision must match IWAC_DATASET_REVISION");
}

/** Decode a base64 little-endian float32 vector. */
export function decodeVector(base64: string): Float32Array {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0 || bytes.length % 4) throw new Error("Probe vector is not float32 data");
  const out = new Float32Array(bytes.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = bytes.readFloatLE(i * 4);
  return out;
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

/**
 * Refuse a query encoder that does not reproduce the reference vector for the
 * probe query. Catches a wrong model behind a `local` endpoint, a tokenizer or
 * runtime that drifted, and a dtype too coarse for the corpus: none of these
 * shows in a model name. A contract without a probe is an operator's
 * declaration and is taken at its word.
 */
export function verifyProbeVector(contract: EmbeddingContract, encoded: ArrayLike<number>): void {
  if (!contract.probe) return;
  const reference = decodeVector(contract.probe.vector);
  const score = encoded.length === reference.length ? cosine(encoded, reference) : Number.NaN;
  if (!(score >= PROBE_MIN_COSINE)) {
    throw new Error(
      `The query encoder does not reproduce ${contract.model}: its vector for the probe query has cosine ` +
        `${Number.isFinite(score) ? score.toFixed(5) : "n/a"} to the reference (needs >= ${PROBE_MIN_COSINE}). ` +
        "Semantic search is refused rather than ranking the corpus with a different model.",
    );
  }
}

/**
 * Refuse a vector column that is not in the contract's space. Each anchor is a
 * stored item whose cosine to the reference probe vector was measured when the
 * contract was made; a column embedded by any other model gives different
 * cosines. One edited or re-embedded anchor must not disable search, so a
 * strict majority of the anchors present must agree, and at least one must be
 * present.
 */
export function verifyCorpusAnchors(
  contract: EmbeddingContract,
  subset: Subset,
  rowOf: (id: string) => Float32Array | undefined,
): void {
  if (!contract.probe || !contract.anchors) return;
  const anchors = contract.anchors.filter((a) => a.subset === subset);
  if (!anchors.length) {
    throw new Error(`The embedding contract has no anchors for ${subset}, so its vectors cannot be verified.`);
  }
  const probe = decodeVector(contract.probe.vector);
  let present = 0,
    agree = 0;
  const seen: string[] = [];
  for (const a of anchors) {
    const row = rowOf(a.id);
    if (!row) continue;
    present++;
    const score = cosine(row, probe);
    if (Math.abs(score - a.cosine) <= ANCHOR_TOLERANCE) agree++;
    else seen.push(`${a.id}: ${score.toFixed(4)} (expected ${a.cosine})`);
  }
  if (present === 0 || agree * 2 <= present) {
    throw new Error(
      `The ${subset} vectors in this dataset revision are not ${contract.model} vectors as this server expects ` +
        `(${agree} of ${present} anchor items agree${seen.length ? `; ${seen.join(", ")}` : ""}). ` +
        "Semantic search is refused rather than ranking across two embedding spaces. " +
        "If the corpus was re-embedded, update the server.",
    );
  }
}
