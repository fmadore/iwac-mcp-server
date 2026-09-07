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
