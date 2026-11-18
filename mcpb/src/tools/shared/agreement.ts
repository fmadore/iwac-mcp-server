/** Cohen's kappa from a contingency table; null means the denominator is undefined. */
export function agreementMetrics(counts: Record<string, Record<string, number>>, order: readonly string[]) {
  const labels = [...new Set([...Object.keys(counts), ...Object.values(counts).flatMap(Object.keys)])];
  const rows = new Map<string, number>();
  const cols = new Map<string, number>();
  let n = 0;
  let agreements = 0;
  for (const a of labels) for (const b of labels) {
    const c = counts[a]?.[b] ?? 0;
    n += c;
    rows.set(a, (rows.get(a) ?? 0) + c);
    cols.set(b, (cols.get(b) ?? 0) + c);
    if (a === b) agreements += c;
  }
  const expected = labels.reduce((s, label) => s + (rows.get(label) ?? 0) * (cols.get(label) ?? 0), 0);
  const denominator = n * n - expected;
  const kappa = n && denominator > 0 ? (n * agreements - expected) / denominator : null;
  // Quadratic disagreement weights. Non-ordinal labels (e.g. Non applicable)
  // are excluded from BOTH marginals, with their own explicit denominator.
  const margins = order.map((label) => ({
    label,
    row: order.reduce((s, b) => s + (counts[label]?.[b] ?? 0), 0),
    col: order.reduce((s, a) => s + (counts[a]?.[label] ?? 0), 0),
  }));
  const weightedN = margins.reduce((a, m) => a + m.row, 0);
  let observedDisagreement = 0;
  let expectedDisagreement = 0;
  margins.forEach(({ label: a, row }, i) => {
    margins.forEach(({ label: b, col }, j) => {
    const weight = (i - j) ** 2;
    observedDisagreement += weight * (counts[a]?.[b] ?? 0);
    expectedDisagreement += weight * row * col;
    });
  });
  return {
    common_scored: n,
    agreements,
    agreement_percent: n ? Math.round(agreements / n * 1000) / 10 : null,
    kappa,
    weighted_kappa: weightedN && expectedDisagreement > 0
      ? 1 - weightedN * observedDisagreement / expectedDisagreement : null,
    weighted_n: weightedN,
  };
}
