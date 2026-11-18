/**
 * Read `list[i]` where the caller has already proved `i` in range (two arrays
 * built in lockstep, an index taken from the same array). Under
 * `noUncheckedIndexedAccess` a bare read types as `T | undefined`; this keeps
 * the proof honest at runtime, throwing a named error instead of letting an
 * `undefined` flow on into a wrong number or a later TypeError.
 *
 * Not for arrays whose elements may themselves be `undefined`, and not for the
 * hot numeric loops (pca.ts, the vector scans), which carry their own
 * documented assertions.
 */
export function itemAt<T>(list: ArrayLike<T>, i: number): T {
  const value = list[i];
  if (value === undefined) throw new RangeError(`index ${i} outside a list of ${list.length}`);
  return value;
}
