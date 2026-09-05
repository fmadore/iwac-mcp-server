import { deepEqual, equal, throws, ok } from "node:assert/strict";
import { test } from "node:test";
import { isFiniteVector, normalizeVector } from "../src/vectors.js";

test("rejects missing, ragged and non-finite vectors", () => {
  for (const value of [null, [], [1, NaN], [Infinity], ["1"], [undefined]]) {
    equal(isFiniteVector(value), false);
  }
  equal(isFiniteVector([1, 2], 3), false);
  equal(isFiniteVector([1, 2], 2), true);
  throws(() => normalizeVector([NaN]), /finite/);
});

test("normalizes without mutating input, including zeros and large finite values", () => {
  const input = [3, 4];
  const vector = normalizeVector(input);
  ok(Math.abs(vector[0] - 0.6) < 1e-7);
  ok(Math.abs(vector[1] - 0.8) < 1e-7);
  deepEqual(input, [3, 4]);
  deepEqual(normalizeVector([0, 0]), new Float32Array(2));
  const large = normalizeVector([Number.MAX_VALUE, Number.MAX_VALUE]);
  ok(Math.abs(large[0] - Math.SQRT1_2) < 1e-7);
});
