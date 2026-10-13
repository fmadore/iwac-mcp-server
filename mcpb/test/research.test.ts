import { test } from "node:test";
import assert from "node:assert/strict";
import { DuckDBConnection } from "@duckdb/node-api";
import { project2d } from "../src/pca.js";
import { WorkQueue, withRequest } from "../src/request.js";
import { normalizeDateBound, validateDateBounds, dateRangeFilter } from "../src/tools/shared/filters.js";
import { aggregateFilters } from "../src/tools/aggregates/shared.js";
import { narrowSelection, selectionFrom } from "../src/selection.js";
import { query, type Bindable } from "../src/db.js";
import {
  decodeVector,
  EMBEDDING_COLUMNS,
  embeddingContract,
  validateEmbeddingContract,
  verifyCorpusAnchors,
  verifyProbeVector,
} from "../src/embeddingContract.js";
import { config } from "../src/config.js";

// Analytic covariance: x has the farthest point but only 50/550 of the variance.
test("PCA finds dominant axes even when the farthest row is orthogonal", () => {
  const vectors = [
    [5, 0, 0],
    [-5, 0, 0],
  ];
  for (let i = 0; i < 10; i++) vectors.push([0, 4, 0], [0, -4, 0], [0, 0, 3], [0, 0, -3]);
  const result = project2d(vectors);
  assert.ok(Math.abs(result.explained[0] - 320 / 550) < 1e-8);
  assert.ok(Math.abs(result.explained[1] - 180 / 550) < 1e-8);
  assert.deepEqual(result, project2d(vectors));
  assert.deepEqual(
    project2d([
      [2, 2],
      [2, 2],
    ]).explained,
    [0, 0],
  );
  const tied = project2d([
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]);
  for (const fraction of tied.explained) assert.ok(Math.abs(fraction - 0.5) < 1e-8);
  assert.ok(
    Math.abs(
      project2d([
        [1, 2],
        [2, 4],
        [3, 6],
      ]).explained[0] - 1,
    ) < 1e-8,
  );
});

test("date bounds reject complete malformed inputs and overlap partial stored dates", async () => {
  for (const date of ["2024-02-31", "2023-02-29", "2024-03-01garbage", "2024-03-01T25:00:00Z", "0000", "2024-00"])
    assert.ok(validateDateBounds(date).err, date);
  assert.equal(normalizeDateBound("2024-02", "to"), "2024-02-29");
  assert.equal(normalizeDateBound("1900-02", "to"), "1900-02-28");
  assert.equal(normalizeDateBound("2024-03-01T12:30:00+01:00", "from"), "2024-03-01");
  assert.ok(validateDateBounds("2025", "2024").err);
  const where: string[] = [],
    params: Bindable[] = [];
  dateRangeFilter(new Set(["pub_date"]), where, params, "1995-06-10", "1995-06-20");
  const rows = await query(
    `SELECT pub_date FROM (VALUES ('1995'),('1995-06'),('1995-06-15'),('1995-06-01'),('1994'),('1995-02-31')) t(pub_date) WHERE ${where.join(" AND ")}`,
    params,
  );
  assert.deepEqual(
    rows.map((r) => r.pub_date),
    ["1995", "1995-06", "1995-06-15"],
  );
});

test("selections intersect exact facets, preserve modes, and reject unsupported filters", async () => {
  const selected = narrowSelection(
    selectionFrom({
      country: "Benin",
      keyword: "mosquée ramadan",
      keyword_mode: "all_terms",
      date_from: "2000",
      exact: { spatial: ["Cotonou"] },
    }),
    "spatial",
    "Lomé",
  );
  assert.deepEqual(selected.exact?.spatial, ["Cotonou", "Lomé"]);
  const filter = aggregateFilters("articles", new Set(["title", "country", "pub_date", "spatial"]), selected);
  assert.equal(filter.err, undefined);
  assert.ok(filter.params.includes("Cotonou"));
  assert.ok(filter.params.includes("Lomé"));
  assert.ok(aggregateFilters("references", new Set(["title"]), { exact: { topic_id: ["3"] } }).err);
  assert.ok(
    aggregateFilters("articles", new Set(["title"]), {
      keyword: "x",
      keyword_mode: "all_terms",
      keyword_aliases: ["y"],
    }).err,
  );
});

test("work queues bound load, cancel waiters, and release capacity", async () => {
  const queue = new WorkQueue(1, 1, 25),
    release = await queue.acquire();
  const controller = new AbortController(),
    waiting = queue.acquire(controller.signal);
  await assert.rejects(queue.acquire(), /full/);
  controller.abort();
  await assert.rejects(waiting, /cancelled/);
  assert.equal(queue.queued, 0);
  release();
  assert.equal(queue.active, 0);
  const hold = await queue.acquire();
  await assert.rejects(queue.acquire(), /deadline/);
  hold();
  const done = await queue.acquire();
  done();
  done();
  assert.equal(queue.active, 0);
  await withRequest(AbortSignal.abort(), async () => {
    await assert.rejects(queue.acquire(AbortSignal.abort()));
  });
});

test("equal embedding dimensions cannot bypass model identity", () => {
  const contract = {
    model: "fixture-model",
    revision: "v1",
    dimension: 768,
    normalization: "unit-l2" as const,
    fields: { articles: "embedding_OCR" },
    query_prefix: "",
  };
  assert.throws(() => validateEmbeddingContract(contract, "articles", "wrong-field"), /no wrong-field vectors/);
  const original = { ...config };
  try {
    Object.assign(config, { embeddingModel: "gemini-embedding-2" });
    assert.throws(() => validateEmbeddingContract(contract, "articles", "embedding_OCR"), /IWAC_EMBEDDING_MODEL is gemini-embedding-2/);
    Object.assign(config, { embeddingModel: "fixture-model", embeddingDimensionality: 3072 });
    assert.throws(() => validateEmbeddingContract(contract, "articles", "embedding_OCR"), /IWAC_EMBEDDING_DIMENSIONALITY/);
    Object.assign(config, { embeddingDimensionality: 768 });
    validateEmbeddingContract(contract, "articles", "embedding_OCR");
    assert.throws(
      () => validateEmbeddingContract({ ...contract, dataset_revision: "f".repeat(40) }, "articles", "embedding_OCR"),
      /dataset_revision must match/,
    );
  } finally {
    Object.assign(config, original);
  }
});

test("the published contract carries a unit probe and anchors for every vector column", () => {
  const contract = embeddingContract();
  assert.equal(contract.model, "google/embeddinggemma-2");
  assert.equal(contract.dataset_revision, undefined, "no revision pin: the vectors are checked instead");
  assert.deepEqual(contract.fields, EMBEDDING_COLUMNS);
  const probe = decodeVector(contract.probe?.vector ?? "");
  assert.equal(probe.length, contract.dimension);
  assert.ok(Math.abs(Math.hypot(...probe) - 1) < 1e-4);
  for (const subset of Object.keys(EMBEDDING_COLUMNS))
    assert.ok((contract.anchors ?? []).filter((a) => a.subset === subset).length >= 3, `${subset} needs anchors`);
  verifyProbeVector(contract, probe);
  assert.throws(() => verifyProbeVector(contract, probe.map((v, i) => (i % 2 ? v : -v))), /does not reproduce/);
  assert.throws(() => verifyProbeVector(contract, probe.slice(0, 256)), /cosine n\/a/);
});

test("corpus anchors refuse another vector space and tolerate one edited item", () => {
  const unit = (values: number[]) => Float32Array.from(values, (v) => v / Math.hypot(...values));
  const probe = unit([1, 0, 0]);
  const contract = {
    model: "fixture-model",
    revision: "v1",
    dimension: 3,
    normalization: "unit-l2" as const,
    fields: { articles: "embedding_OCR" },
    query_prefix: "",
    probe: { query: "probe", vector: Buffer.from(probe.buffer).toString("base64") },
    anchors: [
      { subset: "articles", id: "1", cosine: 0.6 },
      { subset: "articles", id: "2", cosine: 0.8 },
      { subset: "articles", id: "3", cosine: 0 },
    ],
  };
  const rows: Record<string, Float32Array> = { "1": unit([0.6, 0.8, 0]), "2": unit([0.8, 0, 0.6]), "3": unit([0, 1, 0]) };
  verifyCorpusAnchors(contract, "articles", (id) => rows[id]);
  // One anchor re-embedded after an edit: the other two still vouch for the space.
  verifyCorpusAnchors(contract, "articles", (id) => (id === "3" ? unit([0.5, 0.5, 0]) : rows[id]));
  // A deleted anchor shrinks the vote; the rest must still agree.
  verifyCorpusAnchors(contract, "articles", (id) => (id === "1" ? undefined : rows[id]));
  // Another model: the cosines move everywhere.
  assert.throws(
    () => verifyCorpusAnchors(contract, "articles", (id) => unit([0.2, Number(id), 0.3])),
    /not fixture-model vectors .*0 of 3 anchor items agree/,
  );
  // Half is not a majority, and no anchor at all is no evidence.
  assert.throws(() => verifyCorpusAnchors(contract, "articles", (id) => (id === "1" ? rows[id] : id === "2" ? unit([0, 0, 1]) : undefined)), /1 of 2/);
  assert.throws(() => verifyCorpusAnchors(contract, "articles", () => undefined), /0 of 0/);
  assert.throws(() => verifyCorpusAnchors(contract, "references", (id) => rows[id]), /no anchors for references/);
});

test("request cancellation interrupts active DuckDB work and returns its connection", async () => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10);
  try {
    await assert.rejects(
      withRequest(controller.signal, () => query("SELECT sum(sin(i)) FROM range(1000000000) t(i)")),
      /interrupt|abort/i,
    );
    assert.equal(Number((await query("SELECT 1 AS n"))[0].n), 1);
  } finally {
    clearTimeout(timeout);
  }
});

test("request cancellation interrupts DuckDB work issued but not yet executing", async () => {
  // DuckDB drops an interrupt that arrives while the statement is still being
  // prepared; the test above loses that race only sometimes. Abort
  // synchronously right after the statement is issued to hit it every time.
  const controller = new AbortController();
  const original = DuckDBConnection.prototype.runAndReadAll;
  DuckDBConnection.prototype.runAndReadAll = function (this: DuckDBConnection, ...args) {
    const pending = original.apply(this, args);
    controller.abort();
    return pending;
  };
  try {
    await assert.rejects(
      withRequest(controller.signal, () => query("SELECT sum(sin(i)) FROM range(1000000000) t(i)")),
      /interrupt/i,
    );
  } finally {
    DuckDBConnection.prototype.runAndReadAll = original;
  }
  assert.equal(Number((await query("SELECT 1 AS n"))[0].n), 1);
});
