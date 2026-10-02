import { test } from "node:test";
import assert from "node:assert/strict";
import { agreementMetrics } from "../src/tools/shared/agreement.js";
import { requireSemanticFilters } from "../src/tools/_semantic.js";
import { colsFor } from "../src/tools/shared/fields.js";
import { DEFAULT_SENTIMENT_MODEL, sentimentCols } from "../src/tools/shared/sentiment.js";

test("kappa uses each pair's marginals and keeps ordinal denominator explicit", () => {
  // 20 observations, 80% agreement, 50% chance agreement => kappa 0.6.
  const result = agreementMetrics({ a: { a: 8, b: 2 }, b: { a: 2, b: 8 } }, ["a", "b"]);
  assert.equal(result.common_scored, 20);
  assert.equal(result.kappa, 0.6);
  assert.equal(result.weighted_kappa, 0.6);
  const nonordinal = agreementMetrics({ a: { a: 8, b: 2 }, b: { a: 2, b: 8 }, "Non applicable": { "Non applicable": 10 } }, ["a", "b"]);
  assert.equal(nonordinal.common_scored, 30);
  assert.equal(nonordinal.weighted_n, 20);
  assert.equal(nonordinal.weighted_kappa, 0.6);
});

test("empty or degenerate marginals do not produce misleading kappa or NaN", () => {
  for (const counts of [{}, { a: { a: 12 } }] as Record<string, Record<string, number>>[]) {
    const result = agreementMetrics(counts, ["a", "b"]);
    assert.equal(result.kappa, null);
    assert.equal(result.weighted_kappa, null);
  }
  assert.equal(agreementMetrics({}, ["a", "b"]).agreement_percent, null);
  assert.equal(agreementMetrics({ a: { b: 5 }, b: { a: 5 } }, ["a", "b"]).kappa, -1);
});

test("inline sentiment identifies its scorer only when a label is projected", () => {
  const schema = new Set(["o:id", sentimentCols(DEFAULT_SENTIMENT_MODEL).polarity]);
  assert.match(colsFor("articles", schema, "summary"), /'gpt-5-6-luna' AS sentiment_model/);
  assert.doesNotMatch(colsFor("articles", new Set(["o:id"]), "summary"), /sentiment_model/);
});

test("semantic prefilters reject absent requested columns", () => {
  assert.throws(() => requireSemanticFilters(new Set(), { country: "Benin" }), /no country column/);
  assert.doesNotThrow(() => requireSemanticFilters(new Set(), { country: undefined }));
});
