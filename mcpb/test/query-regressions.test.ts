import assert from "node:assert/strict";
import { test } from "node:test";
import { query } from "../src/db.js";
import { keywordExcerpts } from "../src/tools/shared/text.js";
import { aggregateFilters } from "../src/tools/aggregates/shared.js";

test("blank keyword selections are rejected and excerpt helpers remain bounded", () => {
  for (const keyword of ["", " ", "\n\t"]) {
    assert.equal(keywordExcerpts("some source text", keyword).match_count, 0);
    for (const keyword_mode of ["literal", "all_terms"] as const) {
      assert.ok(aggregateFilters("articles", new Set(["title"]), { keyword, keyword_mode }).err);
    }
  }
  assert.ok(aggregateFilters("articles", new Set(["title"]), { keyword_mode: "all_terms" }).err);
  assert.ok(aggregateFilters("articles", new Set(["title"]), { keyword: "islam", keyword_aliases: [" "] }).err);
  const result = keywordExcerpts("a ".repeat(100_000), "a", { contextChars: 200, maxExcerpts: 2 });
  assert.equal(result.match_count, 100_000);
  assert.equal(result.excerpts.length, 2);
  assert.equal(result.truncated, true);
});

test("all shared selections apply date intervals at the requested precision", async () => {
  for (const subset of ["articles", "publications", "references", "documents", "images", "audiovisual"] as const) {
    const filter = aggregateFilters(subset, new Set(["pub_date"]), {
      date_from: "1995-06-10", date_to: "1995-06-20",
    });
    assert.equal(filter.err, undefined);
    const rows = await query(`SELECT pub_date FROM (VALUES
      ('1995'), ('1995-06'), ('1995-06-15'), ('1995-06-15T12:30:00Z'),
      ('1995-04/1995-06'), ('1995-06-19/1995-07-01'),
      ('1995-06-01'), ('1995-07-01'), ('1995-02-31'), ('1995-07/1995-06'),
      ('1995-06-15T99:00:00Z'), ('1995-06-15garbage'), ('0000'), ('')
      ) t(pub_date) WHERE ${filter.where.join(" AND ")}`, filter.params);
    assert.deepEqual(rows.map((r) => r.pub_date), [
      "1995", "1995-06", "1995-06-15", "1995-06-15T12:30:00Z", "1995-04/1995-06", "1995-06-19/1995-07-01",
    ], subset);
  }
});

test("country_raw selects a grouped country combination without widening to its members", async () => {
  const filter = aggregateFilters("references", new Set(["country"]), { exact: { country_raw: [" Niger|Nigeria "] } });
  assert.equal(filter.err, undefined);
  const rows = await query(`SELECT country FROM (VALUES ('Niger'), ('Nigeria'), ('Niger|Nigeria')) t(country)
    WHERE ${filter.where.join(" AND ")}`, filter.params);
  assert.deepEqual(rows.map((r) => r.country), ["Niger|Nigeria"]);
});
