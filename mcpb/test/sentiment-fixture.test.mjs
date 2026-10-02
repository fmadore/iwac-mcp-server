import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { withFixtureScope } from "./_fixture-client.mjs";

test("sentiment selection and selected-pair statistics preserve their populations", async () =>
  withFixtureScope(async (scope) => {
    const { client } = await scope.connect({ name: "sentiment-regressions", stderr: "ignore" });
    const call = async (args) => {
      const r = await client.callTool({ name: "get_sentiment_distribution", arguments: args });
      assert.ok(!r.isError, JSON.stringify(r));
      return r.structuredContent ?? JSON.parse(r.content[0].text);
    };
    const all = await call({ model: "all" });
    assert.equal(all.agreement.scored_by_all, 5);
    assert.equal(all.agreement_matrix.common_scored, 6);
    const pair = await call({ model: "all", compare_models: ["luna", "qwen"] });
    assert.equal(pair.agreement_matrix.cols, "qwen3-8-27b");
    assert.equal(pair.agreement_matrix.common_scored, 5);
    assert.equal(pair.agreement_matrix.excluded_articles, 1);
    const centrality = await call({ model: "all", compare_models: ["luna", "mistral"], agreement_field: "centrality" });
    assert.equal(centrality.agreement_matrix.field, "centrality");
    assert.ok(Object.keys(centrality.agreement_matrix.counts).includes("Très central"));
    const selected = await call({ model: "all", keyword: "ramadan", date_from: "1995", date_to: "1995" });
    assert.ok(selected.total_articles < all.total_articles);
    assert.equal(selected.filters.keyword, "ramadan");
    assert.equal(selected.filters.date_from, "1995");
    const empty = await call({ model: "all", keyword: "not-in-the-fixture-908234" });
    assert.equal(empty.agreement_matrix.common_scored, 0);
    assert.equal(empty.agreement_matrix.kappa, null);
    assert.equal(empty.agreement_matrix.weighted_kappa, null);
    assert.equal(empty.agreement_matrix.agreement_percent, null);
    const degenerate = await call({ model: "all", keyword: "ramadan", exact: { newspaper: ["La Nation"] } });
    assert.ok("kappa" in degenerate.agreement_matrix);
    for (const args of [
      { compare_models: ["luna", "qwen"] },
      { model: "all", compare_models: ["luna", "openai"] },
      { model: "all", compare_models: ["luna", "not-a-model"] },
    ]) assert.ok((await client.callTool({ name: "get_sentiment_distribution", arguments: args })).isError);
  }),
);


test("old schemas reject unavailable sentiment pairs and semantic date constraints", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "iwac-sentiment-schema-"));
  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  try {
    await fs.cp(new URL("./fixtures/", import.meta.url), dir, { recursive: true });
    const file = path.join(dir, "articles", "train-00000-of-00001.parquet");
    const escaped = file.replaceAll("\\", "/").replaceAll("'", "''");
    await conn.run(`CREATE TABLE edited AS SELECT * FROM read_parquet('${escaped}')`);
    for (const column of ["mistral_small_2603_polarite", "deepseek_v4_flash_0731_polarite", "gemma_4_31b_it_polarite", "qwen3_8_27b_polarite", "pub_date"]) {
      await conn.run(`ALTER TABLE edited DROP COLUMN "${column}"`);
    }
    await fs.rm(file);
    await conn.run(`COPY edited TO '${escaped}' (FORMAT PARQUET)`);
    await withFixtureScope(async (scope) => {
      const { client } = await scope.connect({ name: "sparse-sentiment", cacheDir: dir, stderr: "ignore", env: { IWAC_SEMANTIC_SEARCH_ENABLED: "true" } });
      const request = async (name, args) => client.callTool({ name, arguments: args });
      assert.ok(!(await request("get_sentiment_distribution", { model: "all" })).isError);
      for (const args of [{ model: "all", compare_models: ["luna", "qwen"] }, { model: "all", agreement_field: "centrality" }]) {
        assert.ok((await request("get_sentiment_distribution", args)).isError);
      }
      const semantic = await request("semantic_search_articles", { query: "imam", date_from: "", date_to: "2000" });
      assert.ok(semantic.isError);
      assert.match(semantic.content[0].text, /no pub_date column/);
      const definition = (await client.listTools()).tools.find((t) => t.name === "semantic_search_articles");
      assert.equal(definition.annotations.openWorldHint, true);
    });
  } finally {
    conn.closeSync(); db.closeSync();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
