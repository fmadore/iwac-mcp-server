import { deepEqual, equal, throws, ok } from "node:assert/strict";
import { test } from "node:test";
import { isFiniteVector, normalizeVector, parseRelated, writeUnitVector } from "../src/vectors.js";

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

test("parseRelated keeps a related_articles cell in stored order", () => {
  // Ties stay as upstream wrote them (string o:id: "100" before "9"), and an
  // ascending pair is NOT re-sorted: the stored order is the ranking.
  deepEqual(parseRelated("100:0.9000|9:0.9000|5:0.8000"), [
    { id: "100", score: 0.9 },
    { id: "9", score: 0.9 },
    { id: "5", score: 0.8 },
  ]);
  deepEqual(parseRelated("5:0.1|6:0.9").map((n) => n.id), ["5", "6"]);
  deepEqual(parseRelated(" 5 : 0.5 | 6:0.4 "), [{ id: "5", score: 0.5 }, { id: "6", score: 0.4 }]);
});

test("parseRelated skips what it cannot trust instead of guessing", () => {
  for (const cell of [null, undefined, "", "   ", 42, Number.NaN]) deepEqual(parseRelated(cell), []);
  // No colon, no id, a non-integer id, no score, a word, a non-finite or a hex score.
  deepEqual(parseRelated("7|:0.5|x:0.9|8.5:0.9|11:|8:abc|9:inf|10:0x10|12:0.5").map((n) => n.id), ["12"]);
  // A repeat keeps its first position, and "007" is the same o:id as "7".
  deepEqual(parseRelated("7:0.9|8:0.8|007:0.7"), [{ id: "7", score: 0.9 }, { id: "8", score: 0.8 }]);
  // The row itself never counts as its own neighbour.
  deepEqual(parseRelated("3:0.99|4:0.98", "3").map((n) => n.id), ["4"]);
});
