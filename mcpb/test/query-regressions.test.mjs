import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { withFixtureScope } from "./_fixture-client.mjs";

const payload = (r) => r.structuredContent ?? JSON.parse(r.content[0].text);
const call = async (client, name, args) => {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  return payload(result);
};

async function withEditedSubset(subset, transform, run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "iwac-query-regression-"));
  const db = await DuckDBInstance.create(":memory:"), conn = await db.connect();
  try {
    await fs.cp(new URL("./fixtures/", import.meta.url), directory, { recursive: true });
    const file = path.join(directory, subset, "train-00000-of-00001.parquet");
    const escaped = file.replaceAll("\\", "/").replaceAll("'", "''");
    await conn.run(`CREATE TABLE edited AS SELECT * FROM read_parquet('${escaped}')`);
    await transform(conn);
    await fs.rm(file);
    await conn.run(`COPY edited TO '${escaped}' (FORMAT PARQUET)`);
    await withFixtureScope(async (scope) => {
      const { client } = await scope.connect({ name: "query-regressions", cacheDir: directory, stderr: "ignore" });
      await run(client, conn);
    });
  } finally {
    conn.closeSync(); db.closeSync();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("concordance rejects blank all_terms and remains usable for the next request", async () => {
  await withFixtureScope(async (scope) => {
    const { client } = await scope.connect({ name: "blank-concordance", stderr: "ignore" });
    const result = await client.callTool({ name: "explore_corpus", arguments: {
      mode: "concordance", selection: { keyword: " ", keyword_mode: "all_terms" },
    } });
    assert.ok(result.isError);
    assert.ok((await call(client, "explore_corpus", { selection: { keyword: "pèlerinage" } })).total_matches > 0);
  });
});

test("day-scoped research and aggregates exclude records in another month", async () => {
  await withFixtureScope(async (scope) => {
    const { client } = await scope.connect({ name: "date-scope", stderr: "ignore" });
    const selection = { date_from: "1995-07-01", date_to: "1995-07-31" };
    assert.equal((await call(client, "explore_corpus", { subset: "publications", selection })).total_matches, 0);
    assert.equal((await call(client, "get_temporal_distribution", { subset: "publications", ...selection })).total_matches, 0);
    assert.equal((await call(client, "explore_corpus", {
      subset: "documents", selection: { date_from: "1994-07-01", date_to: "1994-07-31" },
    })).total_matches, 0);
    const lunarSelection = { hijri_month: "Ramadan" };
    const lunarItems = await call(client, "explore_corpus", { selection: lunarSelection });
    const lunarChart = await call(client, "get_field_distribution", { field: "subject", ...lunarSelection });
    assert.equal(lunarChart.total_matches, lunarItems.total_matches);
    assert.ok(lunarChart.total_matches > 0 && lunarChart.total_matches < 6);
    assert.equal(lunarChart.filters.hijri_month, "Ramadan");
  });
});

test("Gregorian precision separates invalid, missing, imprecise and plotted dates", async () => {
  await withEditedSubset("publications", async (conn) => {
    await conn.run(`INSERT INTO edited ("o:id", title, pub_date) VALUES
      ('901', 'month', '1995-06'), ('902', 'range', '1995-06/1995-07'),
      ('903', 'invalid', '1995-02-31'), ('904', 'undated', ' '),
      ('905', 'same month range', '1995-06-25/1995-06-28'), ('906', 'reverse', '1995-07/1995-06')`);
  }, async (client) => {
    const result = await call(client, "get_temporal_distribution", {
      subset: "publications", granularity: "month", normalize_by: "scope",
    });
    assert.equal(result.total_matches, 9);
    assert.equal(result.dated_count, 3);
    assert.equal(result.imprecise_date_count, 3);
    assert.equal(result.invalid_date_count, 2);
    assert.equal(result.undated_count, 1);
    assert.deepEqual(result.distribution, { "1995-06": 3 });
    assert.deepEqual(result.denominators, { all: { "1995-06": 3 } });
    assert.match(result.note, /Gregorian month/);
    const yearly = await call(client, "get_temporal_distribution", { subset: "publications" });
    assert.equal(yearly.dated_count, 6);
    assert.equal(yearly.invalid_date_count, 2);
  });
});

test("optional lexical fields do not prevent remaining metrics from being served", async () => {
  await withEditedSubset("articles", async (conn) => {
    await conn.run('ALTER TABLE edited DROP COLUMN "Lisibilite_OCR"');
    await conn.run("ALTER TABLE edited DROP COLUMN pub_date");
  }, async (client) => {
    const result = await call(client, "get_lexical_metrics", { group_by: "country" });
    assert.equal(result.total_matches, 6);
    assert.ok(result.metrics.mattr && result.metrics.words);
    assert.equal(result.metrics.readability, undefined);
    const unsupported = await client.callTool({ name: "get_lexical_metrics", arguments: { group_by: "year" } });
    assert.ok(unsupported.isError);
    assert.match(unsupported.content[0].text, /not available/);
  });
});

test("semantic-map bounded sample retains dimension, validity and deterministic ordering", async () => {
  await withEditedSubset("articles", async (conn) => {
    await conn.run(`INSERT INTO edited ("o:id", title, embedding_OCR) VALUES
      ('901','missing',NULL), ('902','empty',[]), ('903','zero',[0,0,0,0]),
      ('904','null component',[1,NULL,0,0]), ('905','nan',['NaN'::FLOAT,1,0,0]),
      ('906','infinite',['Infinity'::FLOAT,1,0,0]), ('907','wrong dimension',[1,2,3])`);
    await conn.run(`INSERT INTO edited ("o:id", title, embedding_OCR)
      SELECT 's' || CAST(i AS VARCHAR), 'sample', [1, i::FLOAT / 1000, 0, 0] FROM range(1000) t(i)`);
  }, async (client, conn) => {
    const response = await client.callTool({ name: "get_semantic_map", arguments: { limit: 2 } });
    assert.ok(!response.isError, JSON.stringify(response));
    const result = payload(response);
    assert.equal(result.total_matches, 1013);
    assert.equal(result.eligible_embeddings, 1006);
    assert.equal(result.invalid_embeddings, 6);
    assert.equal(result.missing_embeddings, 1);
    assert.equal(result.projected, 2);
    assert.equal(result.omitted_by_limit, 1004);
    const expected = (await conn.runAndReadAll(`SELECT "o:id" AS id FROM edited
      WHERE "o:id" NOT IN ('901','902','903','904','905','906','907')
      ORDER BY md5("o:id" || 'iwac-pca-v1'), "o:id" LIMIT 2`)).getRowObjectsJS().map((r) => r.id);
    const view = response._meta["islam.zmo.de/viewData"];
    assert.deepEqual(view.points.map((p) => p.id), expected);
    const again = await client.callTool({ name: "get_semantic_map", arguments: { limit: 2 } });
    assert.deepEqual(again._meta["islam.zmo.de/viewData"].points, view.points);
  });
});

test("semantic-map dimension ties choose the smaller dimension and empty selections disclose missing vectors", async () => {
  await withEditedSubset("articles", async (conn) => {
    await conn.run(`UPDATE edited SET embedding_OCR = CASE
      WHEN "o:id" IN ('101', '102') THEN [1,2]
      WHEN "o:id" IN ('103', '104') THEN [1,2,3]
      WHEN "o:id" = '105' THEN NULL ELSE [0,0] END`);
  }, async (client) => {
    const response = await client.callTool({ name: "get_semantic_map", arguments: {} });
    assert.ok(!response.isError, JSON.stringify(response));
    const result = payload(response);
    assert.equal(result.eligible_embeddings, 2);
    assert.equal(result.invalid_embeddings, 3);
    assert.equal(result.missing_embeddings, 1);
    assert.deepEqual(response._meta["islam.zmo.de/viewData"].points.map((p) => p.id).sort(), ["101", "102"]);
    const empty = await call(client, "get_semantic_map", { country: "Togo" });
    assert.equal(empty.total_matches, 1);
    assert.equal(empty.projected, 0);
    assert.equal(empty.missing_embeddings, 1);
    assert.equal(empty.invalid_embeddings, 0);
  });
});
