import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { withFixtureScope } from "./_fixture-client.mjs";
const payload = (r) => r.structuredContent ?? JSON.parse(r.content[0].text);

test("research workbench counts, exact selection, normalization, provenance and readers", async () =>
  withFixtureScope(async (scope) => {
    const { client } = await scope.connect({ name: "research-fixtures", stderr: "ignore" });
    const call = async (name, args) => {
      const r = await client.callTool({ name, arguments: args });
      assert.ok(!r.isError, JSON.stringify(r));
      return payload(r);
    };
    const sources = await call("explore_corpus", {
      selection: { country: "Benin", exact: { topic_id: ["12"], spatial: ["Cotonou"] } },
    });
    assert.equal(sources.rows.length, 1);
    assert.equal(sources.rows[0].id, "articles:101");
    const topic = await call("get_topic_distribution", {
      country: "Benin",
      exact: { topic_id: ["12"], spatial: ["Cotonou"] },
    });
    assert.equal(topic.classified, sources.total_matches);
    const context = await call("explore_corpus", {
      mode: "concordance",
      selection: { keyword: "pèlerinage", country: "Benin" },
    });
    assert.ok(context.rows[0].excerpts[0].includes("pèlerinage"));
    assert.equal(context.rows[0].source_field, "OCR");
    assert.equal(context.rows[0].contexts[0].offset_unit, "utf16");
    assert.match(context.rows[0].source_text_sha256, /^[a-f0-9]{64}$/);
    for (const keyword of ["", "  \n\t"]) {
      const empty = await client.callTool({ name: "explore_corpus", arguments: { mode: "concordance", selection: { keyword } } });
      assert.ok(empty.isError, "blank concordance terms fail promptly");
    }
    const coverage = await call("explore_corpus", { mode: "coverage", selection: { country: "Benin" } });
    assert.equal(
      coverage.rows.reduce((n, r) => n + r.total, 0),
      coverage.total_matches,
    );
    assert.ok(coverage.rows.every((r) => r.fulltext <= r.total));
    const countries = await call("explore_corpus", { mode: "coverage", subset: "references" });
    const combinedCountry = countries.rows.find((row) => row.source === "Niger|Nigeria");
    assert.ok(combinedCountry);
    assert.equal(countries.source_exact_field, "country_raw");
    const drilldown = await call("explore_corpus", {
      subset: "references", selection: { exact: { [countries.source_exact_field]: [combinedCountry.source] }, date_from: combinedCountry.year, date_to: combinedCountry.year },
    });
    assert.equal(drilldown.total_matches, combinedCountry.total);
    assert.equal(drilldown.rows[0].id, "references:301");
    const compare = await call("explore_corpus", {
      mode: "compare",
      selection: { country: "Benin" },
      comparison: { country: "Togo" },
    });
    assert.equal(compare.overlap, 0);
    assert.equal(compare.selections.length, 2);
    assert.equal(compare.temporal.normalize_by, "corpus");
    assert.ok(compare.temporal.rows.every((row) => row.count <= row.denominator));
    for (const selection of compare.selections)
      assert.equal(compare.temporal.rows.filter((row) => row.selection === selection.label).reduce((sum, row) => sum + row.count, 0), selection.total);
    const same = await call("explore_corpus", {
      mode: "compare",
      selection: { country: "Benin" },
      comparison: { country: "Benin" },
    });
    assert.equal(same.overlap, same.selections[0].total);
    const trend = await call("get_temporal_distribution", {
      keyword: "ramadan",
      normalize_by: "scope",
      group_by: "country",
    });
    for (const [group, dist] of Object.entries(trend.distribution_by_group))
      for (const [year, n] of Object.entries(dist)) assert.ok(n <= trend.denominators[group][year]);
    const lunar = await call("get_temporal_distribution", { granularity: "lunar_month", group_by: "country" });
    assert.equal(
      Object.values(lunar.distribution_by_group)
        .flatMap(Object.values)
        .reduce((a, b) => a + b, 0),
      lunar.dated_count,
    );
    const attention = await call("explore_corpus", { mode: "attention", selection: { country: "Benin" } });
    assert.ok(attention.rows.some((r) => r.destination === "Cotonou"));
    assert.ok(
      (await client.callTool({ name: "explore_corpus", arguments: { mode: "attention", subset: "references" } }))
        .isError,
    );
    const aliases = await call("explore_corpus", { mode: "aliases", selection: { keyword: "Dahomey" } });
    assert.ok(aliases.rows.some((r) => r.alternate_titles?.includes("Dahomey")));
    const map = await call("get_semantic_map", { limit: 2 });
    assert.equal(map.projected, 2);
    assert.equal(map.omitted_by_limit, map.eligible_embeddings - 2);
    assert.equal(map.total_matches, map.eligible_embeddings + map.invalid_embeddings + map.missing_embeddings);
    const similar = await call("get_similar_items", { id: "articles:101" });
    assert.ok(similar.neighbours.every((n) => n.score >= -1 && n.score <= 1));
    const result = await client.callTool({ name: "explore_corpus", arguments: { limit: 1 } });
    const provenance = result._meta?.["islam.zmo.de/provenance"];
    assert.match(provenance.snapshot_id, /^[a-f0-9]{64}$/);
    assert.ok(provenance.datasets.articles.files[0].identity.startsWith("sha256:"));
    assert.equal(provenance.arguments.limit, 1);
    assert.ok((await call("fetch", { id: payload(result).rows[0].id })).url.startsWith("https://islam.zmo.de/"));

    const exported = await call("explore_corpus", { mode: "manifest", limit: 1 });
    const manifest = JSON.parse(exported.export.content);
    assert.equal(manifest.returned, 1);
    assert.equal(manifest.has_more, true);
    assert.equal(manifest.records[0].id, exported.rows[0].id);
    assert.equal(manifest.provenance.snapshot_id, provenance.snapshot_id);
    assert.ok(manifest.provenance.datasets.articles.files[0].identity.startsWith("sha256:"));
    const csl = await call("explore_corpus", { mode: "csl_json", subset: "references", selection: { country: "Benin" } });
    const citation = JSON.parse(csl.export.content)[0];
    assert.equal(citation.type, "book");
    assert.deepEqual(citation.author, [{ literal: "Kadiri, Aïcha" }]);
    assert.deepEqual(citation.issued, { "date-parts": [[1999]] });
    assert.equal(citation.DOI, undefined);
    assert.ok(csl.export.manifest.provenance.datasets.references);
    const bibtex = await call("explore_corpus", { mode: "bibtex", subset: "references", selection: { country: "Benin" } });
    assert.match(bibtex.export.content, /^@book\{iwac-references:302,/);
    assert.ok(!bibtex.export.content.includes("author = {Unknown}"));
    const second = await call("explore_corpus", { mode: "manifest", limit: 1, offset: 1 });
    const secondManifest = JSON.parse(second.export.content);
    assert.equal(secondManifest.provenance.snapshot_id, manifest.provenance.snapshot_id);
    assert.notEqual(secondManifest.records[0].id, manifest.records[0].id);
    const emptyExport = await call("explore_corpus", { mode: "csl_json", selection: { keyword: "notawordxyz" } });
    assert.deepEqual(JSON.parse(emptyExport.export.content), []);

    const discovered = JSON.parse((await client.readResource({ uri: "iwac://datasets/references" })).contents[0].text);
    assert.equal(discovered.total, 4);
    assert.ok(discovered.columns.some((column) => column.name === "author" && column.type === "VARCHAR"));
    assert.equal(discovered.body_field, "abstract");
    assert.ok(discovered.provenance.datasets.references.files[0].identity.startsWith("sha256:"));
    const templates = await client.listResourceTemplates();
    assert.ok(templates.resourceTemplates.some((template) => template.uriTemplate === "iwac://datasets/{subset}"));
    await assert.rejects(client.readResource({ uri: "iwac://datasets/not-a-subset" }), /Unknown IWAC dataset subset/);
  }));

test("full-text failure remains visible with zero hits and useful metadata hits", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "iwac-search-fault-"));
  const db = await DuckDBInstance.create(":memory:"),
    conn = await db.connect();
  try {
    await fs.cp(new URL("./fixtures/", import.meta.url), directory, { recursive: true });
    const file = path.join(directory, "articles/train-00000-of-00001.parquet");
    await conn.run(
      `CREATE TABLE damaged AS SELECT * EXCLUDE (OCR), [1,2] AS OCR FROM read_parquet('${file.replaceAll("'", "''")}')`,
    );
    await fs.rm(file);
    await conn.run(`COPY damaged TO '${file.replaceAll("'", "''")}' (FORMAT PARQUET)`);
    await withFixtureScope(async (scope) => {
      const { client } = await scope.connect({ name: "fault-search", cacheDir: directory, stderr: "ignore" });
      for (const query of ["notawordxyz", "pèlerinage"]) {
        const r = payload(
          await client.callTool({ name: "search", arguments: { query, category: "articles", limit: 10 } }),
        );
        assert.equal(r.search_coverage.articles.metadata, "searched");
        assert.equal(r.search_coverage.articles.fulltext, "unavailable");
        assert.ok(r.unavailable_categories.includes("articles"));
        assert.match(r.coverage_warning, /full.text/i);
        if (query === "pèlerinage") assert.ok(r.count > 0, "preserve metadata hits");
        else assert.equal(r.count, 0);
      }
    });
  } finally {
    conn.closeSync();
    db.closeSync();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("local embedding adapter requires a matching corpus contract and validates responses", async () => {
  const { createServer } = await import("node:http");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "iwac-local-embedding-"));
  const contract = path.join(directory, "contract.json"),
    revision = "1".repeat(40),
    requests = [];
  await fs.writeFile(
    contract,
    JSON.stringify({
      model: "fixture-model",
      revision: "fixture-v1",
      dimension: 4,
      normalization: "none",
      dataset_revision: revision,
      fields: { articles: "embedding_OCR" },
      query_prefix: "query: ",
    }),
  );
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    requests.push(input);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [{ embedding: input.input[0].includes("zero") ? [0, 0, 0, 0] : [1, 0, 0, 0] }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await withFixtureScope(async (scope) => {
      const { client } = await scope.connect({
        name: "local-embedding",
        stderr: "ignore",
        env: {
          IWAC_SEMANTIC_SEARCH_ENABLED: "true",
          IWAC_EMBEDDING_PROVIDER: "local",
          IWAC_EMBEDDING_MODEL: "fixture-model",
          IWAC_EMBEDDING_DIMENSIONALITY: "4",
          IWAC_DATASET_REVISION: revision,
          IWAC_EMBEDDING_CONTRACT_FILE: contract,
          IWAC_LOCAL_EMBEDDING_URL: `http://127.0.0.1:${server.address().port}/v1/embeddings`,
        },
      });
      const response = await client.callTool({
        name: "semantic_search_articles",
        arguments: { query: "pèlerinage", limit: 2 },
      });
      assert.ok(!response.isError, JSON.stringify(response));
      assert.equal(requests[0].input[0], "query: pèlerinage");
      assert.equal(response._meta["islam.zmo.de/provenance"].embedding_contract.model, "fixture-model");
      const rejected = await client.callTool({
        name: "semantic_search_articles",
        arguments: { query: "zero", limit: 2 },
      });
      assert.ok(rejected.isError);
      assert.match(rejected.content[0].text, /invalid, zero/);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
