// The Node query encoder against the Python reference that embedded the corpus.
//
// test/embeddinggemma2-reference.json holds token ids and fp32 vectors that
// IWAC-Hugging-Face's _gemma_encoder produced for a fixed query set (French,
// English, Arabic, transliteration variants, acronyms, combining marks, a long
// question); scripts/make-embedding-reference.py regenerates it. Each dtype the
// server offers must tokenize identically and reach cosine >= 0.999 on every
// query, the bar a query vector has to clear to rank a corpus it did not embed.
//
// Live: the first run downloads the encoder into the model cache (350 MB for
// q8; add fp32 with IWAC_PARITY_DTYPES=q8,fp32 for another 1.1 GB).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { config } from "../src/config.js";
import { decodeVector, embeddingContract, PROBE_MIN_COSINE } from "../src/embeddingContract.js";
import { ENCODER_DTYPES, encodeQuery, queryTokenIds } from "../src/onnxEncoder.js";

const reference = JSON.parse(readFileSync(new URL("./embeddinggemma2-reference.json", import.meta.url), "utf8")) as {
  model: string;
  query_prefix: string;
  queries: { query: string; token_ids: number[]; vector: string }[];
};
const dtypes = (process.env.IWAC_PARITY_DTYPES ?? "q8").split(",").map((d) => d.trim());

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

test("the reference describes the contract the server ships", () => {
  const contract = embeddingContract();
  assert.equal(reference.model, `${contract.model}@${contract.revision}`);
  assert.equal(reference.query_prefix, contract.query_prefix);
  assert.equal(reference.queries[0].query, contract.probe?.query, "the first reference query is the probe");
  assert.equal(reference.queries[0].vector, contract.probe?.vector);
});

for (const dtype of dtypes) {
  test(`${dtype} encoder matches the Python reference`, { timeout: 30 * 60_000 }, async () => {
    assert.ok((ENCODER_DTYPES as readonly string[]).includes(dtype), `unknown dtype ${dtype}`);
    config.embeddingDtype = dtype;
    let worst = 1;
    for (const { query, token_ids, vector } of reference.queries) {
      const text = reference.query_prefix + query;
      assert.deepEqual(await queryTokenIds(text), token_ids, `token ids differ for ${JSON.stringify(query)}`);
      const score = cosine(await encodeQuery(text), decodeVector(vector));
      worst = Math.min(worst, score);
      assert.ok(score >= PROBE_MIN_COSINE, `${dtype} cosine ${score.toFixed(6)} for ${JSON.stringify(query)}`);
    }
    console.log(`${dtype}: ${reference.queries.length} queries, worst cosine ${worst.toFixed(6)}`);
  });
}
