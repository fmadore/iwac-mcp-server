

/** Maximum length of any single free-text field returned to the model. */
export const CHARACTER_LIMIT = 25000;

// -----------------------------------------------------------------------------
// Input capping (lenient clamp, not rejection)
// -----------------------------------------------------------------------------

export function capLimit(v: number | undefined, def: number, max: number): number {
  return Math.max(1, Math.min(v ?? def, max));
}

export function capOffset(v: number | undefined): number {
  return Math.max(0, v ?? 0);
}

/**
 * A limit clamped to [1, max] that REMEMBERS the original request, so a tool can
 * surface a visible cap (`requested_limit` + `limit_warning`) instead of silently
 * truncating. A list that quietly returns 200 of the 500 rows asked for reads as
 * "that's all there is" — the opposite of what happened.
 *
 * `capped` covers BOTH bounds. The low end matters as much as the high one:
 * `limit: 0` used to return exactly one row with nothing saying why, which reads
 * as "the collection holds one match" — the same silent-truncation trap in
 * miniature.
 */
export interface ResolvedLimit {
  value: number;
  requested: number | undefined;
  capped: boolean;
  max: number;
  /** Why this call's maximum is lower than the tool's documented one, when it
   * is. Without it, a caller who asked for 100 and got 25 has no way to tell a
   * per-call cap from a typo in the docs. */
  reason?: string;
}

export function resolveLimit(v: number | undefined, def: number, max: number, reason?: string): ResolvedLimit {
  const value = Math.max(1, Math.min(v ?? def, max));
  return { value, requested: v, capped: v !== undefined && v !== value, max, reason };
}

/** The visible-cap fields (`requested_limit` + `limit_warning`) for a clamped
 * limit, or {} when nothing was clamped. Single source of the warning wording. */
export function limitWarning(limit: ResolvedLimit): Record<string, unknown> {
  if (!limit.capped || limit.requested === undefined) return {};
  const requested = limit.requested;
  return {
    requested_limit: requested,
    limit_warning:
      requested > limit.max
        ? `Requested limit ${requested} exceeds the maximum ${limit.max}; applied ${limit.value}.${limit.reason ? ` ${limit.reason}` : ""}`
        : `Requested limit ${requested} is below the minimum 1; applied ${limit.value}.`,
  };
}

