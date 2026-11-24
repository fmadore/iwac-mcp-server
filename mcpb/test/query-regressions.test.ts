import assert from "node:assert/strict";
import { test } from "node:test";
import { query } from "../src/db.js";
import { keywordExcerpts } from "../src/tools/shared/text.js";
import { aggregateFilters } from "../src/tools/aggregates/shared.js";
import { allTermsFilter, equalsFilterIfExists, likeFilterIfExists, pipeValueFilterIfExists } from "../src/tools/shared/filters.js";
import type { Bindable } from "../src/db.js";
import { tokenize } from "../src/tools/search.js";
import { paginated, PAGE_CHAR_BUDGET } from "../src/tools/shared/pagination.js";

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

// #70: three silent-widening edge cases of the one keyword rule (D7).
test("an empty quoted keyword is refused instead of selecting the whole subset", () => {
  for (const keyword of ['""', '" "', '""  ""']) {
    const agg = aggregateFilters("articles", new Set(["title"]), { keyword });
    assert.match(agg.err?.error ?? "", /no search term/, keyword);
    const where: string[] = [];
    assert.match(allTermsFilter(new Set(["title"]), where, [], ["title"], keyword) ?? "", /no search term/, keyword);
    assert.equal(where.length, 0);
  }
  // A literal keyword with aliases is matched as written, so it is still runnable.
  assert.equal(aggregateFilters("articles", new Set(["title"]), { keyword: '""', keyword_aliases: ["hadj"] }).err, undefined);
  // An absent or blank keyword on the per-subset tools still means "no keyword".
  assert.equal(allTermsFilter(new Set(["title"]), [], [], ["title"], undefined), undefined);
  assert.equal(allTermsFilter(new Set(["title"]), [], [], ["title"], ""), undefined);
});

test("unified search keeps a quoted phrase whole, like every other tool", () => {
  assert.deepEqual(tokenize('"Ibrahim Niasse"'), ["Ibrahim Niasse"]);
  assert.deepEqual(tokenize('"La Mecque" hadj'), ["La Mecque", "hadj"]);
  assert.deepEqual(tokenize('"a" b'), []);
  assert.deepEqual(tokenize('""'), []);
});

test("whitespace-only exact filters add no predicate instead of matching empty cells", () => {
  const schema = new Set(["subject", "newspaper"]);
  for (const helper of [equalsFilterIfExists, likeFilterIfExists, pipeValueFilterIfExists]) {
    const where: string[] = [];
    const params: Bindable[] = [];
    helper(schema, where, params, "subject", "   ");
    assert.deepEqual([where, params], [[], []], helper.name);
    helper(schema, where, params, "subject", "  Hadj ");
    assert.equal(where.length, 1, helper.name);
    assert.ok(String(params[0]).includes("Hadj") && !String(params[0]).includes(" Hadj"), helper.name);
  }
});

// #71: search_publications read each issue's table of contents (median 7k
// characters), measured the page budget on it, then dropped it, so a 20-row
// keyword page stopped after 5 to 7 rows. The row transform runs first.
test("the page budget measures rows after the caller's transform", async () => {
  const sql = `SELECT i AS id, repeat('x', ${Math.ceil(PAGE_CHAR_BUDGET / 5)}) AS toc FROM range(20) t(i) ORDER BY i`;
  const limit = { value: 20, requested: 20, capped: false, max: 50 };
  const raw = await paginated<Record<string, unknown>>("SELECT 20", [], sql, [], 0, limit);
  assert.ok(raw.count < 20 && raw.response_limited, "untransformed rows hit the budget");
  const shaped = await paginated<Record<string, unknown>>("SELECT 20", [], sql, [], 0, limit, (r) => {
    delete r.toc;
  });
  assert.equal(shaped.count, 20);
  assert.equal(shaped.response_limited, undefined);
  assert.equal(shaped.has_more, false);
});
