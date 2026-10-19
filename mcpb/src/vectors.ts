/** A stored/query vector must be non-empty, finite, and dimensionally consistent. */
export function isFiniteVector(value: unknown, dimension?: number): value is number[] {
  if (!Array.isArray(value) || value.length === 0 ||
    (dimension !== undefined && value.length !== dimension)) return false;
  // Iteration visits sparse-array holes as undefined; Array.every skips them.
  for (const v of value) {
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
  }
  return true;
}

/** Normalize into a new float32 vector; preserve zero vectors as zeros. */
export function normalizeVector(values: number[]): Float32Array {
  if (!isFiniteVector(values)) throw new Error("Embedding must contain finite numbers");
  // Scaling first avoids overflow when squaring unusually large finite values.
  const scale = values.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  if (scale === 0) return new Float32Array(values.length);
  const norm = Math.sqrt(values.reduce((sum, value) => sum + (value / scale) ** 2, 0));
  return Float32Array.from(values, (value) => (value / scale) / norm);
}

/**
 * Validate `values` as a finite, non-zero vector of `dim` numbers and write its
 * unit-length float32 form into `out` at `offset`. Returns false, writing
 * nothing usable, for anything normalizeVector would reject or leave at zero.
 * Index builds call this per row instead of allocating a vector per row: same
 * checks and the same overflow-safe scaling, in three tight passes.
 */
export function writeUnitVector(values: unknown, out: Float32Array, offset: number, dim: number): boolean {
  if (!Array.isArray(values) || values.length !== dim) return false;
  let scale = 0;
  for (let i = 0; i < dim; i++) {
    const v = values[i];
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
    const a = Math.abs(v);
    if (a > scale) scale = a;
  }
  if (scale === 0) return false;
  let sum = 0;
  for (let i = 0; i < dim; i++) sum += (values[i] / scale) ** 2;
  const norm = Math.sqrt(sum);
  for (let i = 0; i < dim; i++) out[offset + i] = values[i] / scale / norm;
  return true;
}

/** One entry of a published neighbour list: an o:id and its stored cosine. */
export interface StoredNeighbour {
  id: string;
  score: number;
}

const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** "007" and "7" are one o:id; anything but digits is not an o:id at all. */
function canonicalId(raw: string): string | undefined {
  return /^\d+$/.test(raw) ? String(BigInt(raw)) : undefined;
}

/**
 * One `related_articles` cell ("o:id:cosine|o:id:cosine|…") as neighbours, in
 * stored order. Reads the cell the way IwacVisualizations' `parse_related`
 * does, so the server and islam.zmo.de cannot list different neighbours from
 * the same cell: a null, blank or non-string cell gives [], an entry without an
 * integer id and a finite score is skipped rather than guessed, a repeated id
 * keeps its first position, and `exclude` (the row's own o:id) is dropped. The
 * order is never re-sorted: it is upstream's ranking, ties included.
 */
export function parseRelated(value: unknown, exclude?: string): StoredNeighbour[] {
  if (typeof value !== "string") return [];
  const self = exclude === undefined ? undefined : canonicalId(exclude.trim());
  const out: StoredNeighbour[] = [];
  const seen = new Set<string>();
  for (const entry of value.split("|")) {
    const cut = entry.lastIndexOf(":");
    if (cut < 0) continue;
    const id = canonicalId(entry.slice(0, cut).trim());
    const rawScore = entry.slice(cut + 1).trim();
    if (id === undefined || !DECIMAL.test(rawScore)) continue;
    const score = Number(rawScore);
    if (!Number.isFinite(score) || id === self || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, score });
  }
  return out;
}
