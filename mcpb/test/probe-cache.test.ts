// The encoder probe and the query cache (issue #76): a failed probe must not
// leave its vector cached, and query vectors are cached only once the encoder
// has been verified. Its own file because the embedding contract is loaded
// once per process (embeddingContract.ts) and this one carries a probe.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { config } from "../src/config.js";
import { allowDirectoriesForTests, query } from "../src/db.js";
import { semanticSearch } from "../src/embeddings.js";
import { withRequest } from "../src/request.js";

allowDirectoriesForTests([os.tmpdir()]);

async function fixture(directory: string, sql: string): Promise<Buffer> {
  const file = path.join(directory, "source.parquet");
  await query(`COPY (${sql}) TO '${file.replaceAll("\\", "/").replaceAll("'", "''")}' (FORMAT parquet)`);
  return fs.readFile(file);
}

test("a failed encoder probe is not cached, so fixing the provider recovers search without a restart", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "iwac-probe-cache-"));
  const original = { ...config },
    originalFetch = globalThis.fetch;
  const oldContract = process.env.IWAC_EMBEDDING_CONTRACT_FILE;
  let wrong = true,
    probeCalls = 0,
    userCalls = 0;
  try {
    const bytes = await fixture(directory, 'SELECT 1 AS "o:id", [1.0, 0.0] AS embedding_image');
    await fs.mkdir(path.join(directory, "images"));
    await fs.writeFile(path.join(directory, "images", "train.parquet"), bytes);
    const revision = "2".repeat(40),
      contract = path.join(directory, "contract.json");
    await fs.writeFile(
      contract,
      JSON.stringify({
        model: "test-model",
        revision: "probe-cache-v1",
        dimension: 2,
        normalization: "unit-l2",
        dataset_revision: revision,
        fields: { images: "embedding_image" },
        query_prefix: "query: ",
        probe: { query: "probe", vector: Buffer.from(new Float32Array([1, 0]).buffer).toString("base64") },
      }),
    );
    process.env.IWAC_EMBEDDING_CONTRACT_FILE = contract;
    Object.assign(config, {
      cacheDir: directory,
      offline: true,
      refreshIntervalMs: 0,
      semanticSearchEnabled: true,
      embeddingProvider: "local",
      embeddingModel: "test-model",
      embeddingDimensionality: 2,
      datasetRevision: revision,
      localEmbeddingUrl: "http://127.0.0.1:8080/v1/embeddings",
    });
    globalThis.fetch = (async (_input, init) => {
      const input = (JSON.parse(String(init?.body)) as { input: string[] }).input[0];
      if (input === "query: probe") probeCalls++;
      else userCalls++;
      // The misconfigured provider answers with a vector of the right width
      // from the wrong space; the fixed one answers correctly.
      return Response.json({ data: [{ embedding: wrong ? [0, 1] : [1, 0] }] });
    }) as typeof fetch;
    const search = () =>
      withRequest(undefined, () =>
        semanticSearch({ subset: "images", embeddingColumn: "embedding_image", query: "mosquée", limit: 1 }),
      );
    await assert.rejects(search(), /does not reproduce test-model/);
    wrong = false;
    assert.deepEqual(await search(), [{ id: "1", score: 1 }]);
    assert.equal(probeCalls, 2, "the retry re-encoded the probe instead of reading the failed vector from the cache");
    assert.equal(userCalls, 2, "the query vector from the unverified encoder was not cached");
    await search();
    assert.equal(userCalls, 2, "a verified query vector is cached");
  } finally {
    if (oldContract === undefined) delete process.env.IWAC_EMBEDDING_CONTRACT_FILE;
    else process.env.IWAC_EMBEDDING_CONTRACT_FILE = oldContract;
    Object.assign(config, original);
    globalThis.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
