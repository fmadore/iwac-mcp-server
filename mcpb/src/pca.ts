// Two-component PCA over a set of embeddings, by power iteration.
//
// This is the cheap stand-in for the UMAP "semantic landscape" the
// IwacVisualizations module ships. It is NOT the same thing and will not look
// like it: UMAP preserves local neighbourhood structure, PCA preserves global
// variance, so PCA spreads a corpus along its two broadest axes and squashes
// the fine cluster structure UMAP is chosen for. The honest use is "what are
// the two biggest axes of variation here", which is why `explained` ships with
// the coordinates — with 768 dimensions the first two components typically
// carry a small share, and a scatter that captures 6% of the variance means
// much less than one that captures 40%.
//
// Power iteration rather than a full eigendecomposition because the data
// matrix is the cheap direction: each pass is O(n·d), against O(d²·n) to even
// form the 768×768 covariance.

export interface Projection {
  /** One [x, y] per input row, in input order. */
  points: [number, number][];
  /** Share of total variance carried by each component, 0-1. */
  explained: [number, number];
  /** Total variance of the centred data, for context. */
  totalVariance: number;
}

/**
 * Project `vectors` (all the same length) onto their first two principal
 * components. Deterministic: the seed is derived from the data, and each
 * component's sign is fixed so the same input always yields the same picture.
 */
export function project2d(vectors: number[][], iterations = 64): Projection {
  const n = vectors.length;
  const d = n ? vectors[0].length : 0;
  if (!n || !d) return { points: [], explained: [0, 0], totalVariance: 0 };
  if (n === 1) return { points: [[0, 0]], explained: [0, 0], totalVariance: 0 };

  // Centre. PCA on uncentred data finds the mean direction as PC1, which for
  // text embeddings is a strong, uninformative "average document" axis.
  const mean = new Float64Array(d);
  for (const v of vectors) for (let j = 0; j < d; j++) mean[j] += v[j];
  for (let j = 0; j < d; j++) mean[j] /= n;

  const X = new Float64Array(n * d);
  let totalVariance = 0;
  for (let i = 0; i < n; i++) {
    const v = vectors[i];
    const off = i * d;
    for (let j = 0; j < d; j++) {
      const c = v[j] - mean[j];
      X[off + j] = c;
      totalVariance += c * c;
    }
  }
  totalVariance /= n;

  const component = (): { axis: Float64Array; scores: Float64Array; variance: number } => {
    // Seed from the row furthest from the mean: deterministic, and already
    // pointing somewhere in the data's span, so it converges fast.
    let seed = 0;
    let best = -1;
    for (let i = 0; i < n; i++) {
      let norm = 0;
      const off = i * d;
      for (let j = 0; j < d; j++) norm += X[off + j] * X[off + j];
      if (norm > best) {
        best = norm;
        seed = i;
      }
    }
    const axis = new Float64Array(d);
    for (let j = 0; j < d; j++) axis[j] = X[seed * d + j];
    normalise(axis);

    const scores = new Float64Array(n);
    for (let it = 0; it < iterations; it++) {
      // scores = X · axis
      for (let i = 0; i < n; i++) {
        let s = 0;
        const off = i * d;
        for (let j = 0; j < d; j++) s += X[off + j] * axis[j];
        scores[i] = s;
      }
      // axis = Xᵀ · scores
      axis.fill(0);
      for (let i = 0; i < n; i++) {
        const s = scores[i];
        if (s === 0) continue;
        const off = i * d;
        for (let j = 0; j < d; j++) axis[j] += X[off + j] * s;
      }
      if (!normalise(axis)) break;
    }
    // Final scores against the converged axis.
    let variance = 0;
    for (let i = 0; i < n; i++) {
      let s = 0;
      const off = i * d;
      for (let j = 0; j < d; j++) s += X[off + j] * axis[j];
      scores[i] = s;
      variance += s * s;
    }
    variance /= n;

    // An eigenvector is defined up to sign, so pin it: the largest-magnitude
    // coordinate is made positive. Without this the scatter can mirror itself
    // between two runs on identical data.
    let pivot = 0;
    for (let j = 1; j < d; j++) if (Math.abs(axis[j]) > Math.abs(axis[pivot])) pivot = j;
    if (axis[pivot] < 0) {
      for (let j = 0; j < d; j++) axis[j] = -axis[j];
      for (let i = 0; i < n; i++) scores[i] = -scores[i];
    }
    return { axis, scores, variance };
  };

  const first = component();
  // Deflate: remove PC1 from the data so the next pass finds the orthogonal
  // direction of greatest remaining variance.
  for (let i = 0; i < n; i++) {
    const s = first.scores[i];
    const off = i * d;
    for (let j = 0; j < d; j++) X[off + j] -= s * first.axis[j];
  }
  const second = component();

  const points: [number, number][] = [];
  for (let i = 0; i < n; i++) points.push([first.scores[i], second.scores[i]]);
  return {
    points,
    explained: [
      totalVariance > 0 ? first.variance / totalVariance : 0,
      totalVariance > 0 ? second.variance / totalVariance : 0,
    ],
    totalVariance,
  };
}

/** In-place L2 normalise; false if the vector is all zeros (nothing left to find). */
function normalise(v: Float64Array): boolean {
  let norm = 0;
  for (let j = 0; j < v.length; j++) norm += v[j] * v[j];
  if (!(norm > 0)) return false;
  const inv = 1 / Math.sqrt(norm);
  for (let j = 0; j < v.length; j++) v[j] *= inv;
  return true;
}
