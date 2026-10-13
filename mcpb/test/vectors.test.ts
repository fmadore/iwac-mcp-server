import { deepEqual, equal, throws, ok } from "node:assert/strict";
import { test } from "node:test";
import { isFiniteVector, normalizeVector, writeUnitVector } from "../src/vectors.js";

test("rejects missing, ragged and non-finite vectors", () => {
  for (const value of [null, [], [1, NaN], [Infinity], ["1"], [undefined]]) {
    equal(isFiniteVector(value), false);
  }
  equal(isFiniteVector([1, 2], 3), false);
  equal(isFiniteVector([1, 2], 2), true);
  equal(isFiniteVector(new Array(2)), false);
  throws(() => normalizeVector(new Array(2)), /finite/);
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

test("writeUnitVector writes what normalizeVector returns and rejects the same rows", () => {
  const out = new Float32Array(6).fill(9);
  equal(writeUnitVector([3, 4], out, 2, 2), true);
  equal(String(Array.from(out.subarray(2, 4))), String(Array.from(normalizeVector([3, 4]))));
  const huge = [1e300, 1e300];
  equal(writeUnitVector(huge, out, 0, 2), true, "scaling keeps extreme finite values from overflowing");
  equal(String(Array.from(out.subarray(0, 2))), String(Array.from(normalizeVector(huge))));
  for (const bad of [[0, 0], [1, Number.NaN], [1, 2, 3], "12", [1, "2"]]) equal(writeUnitVector(bad, out, 0, 2), false);
});
