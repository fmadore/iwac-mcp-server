// Typed reads of fixture results under `noUncheckedIndexedAccess`: a test
// that indexes into a known result says so here, and a missing element fails
// with a message naming it instead of a TypeError three lines later.

/** `value`, or a thrown error naming `what` when it is null or undefined. */
export function must<T>(value: T | null | undefined, what = "value"): T {
  if (value === undefined || value === null) throw new Error(`expected ${what}, got ${value}`);
  return value;
}

/** `list[i]`, or a thrown error naming the index and the list's length. */
export function at<T>(list: ArrayLike<T> | null | undefined, i: number): T {
  return must(list?.[i], `element ${i} of a list of ${list?.length ?? "nothing"}`);
}
