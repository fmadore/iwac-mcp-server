// Unit tests for query building: country and enum validation (the silent-zero
// guard), limits, item URLs, date and keyword filters, unified-search
// tokenization and interleaving, result compaction and the per-subset field
// descriptor. Split from the former test/unit.test.ts (November 2026);
// `npm run test:unit` runs it (tsx --test).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  colsFor,
  COUNTRIES,
  countryParam,
  dateRangeFilter,
  FAST_TEXT_COLS,
  HAS_HEAVY_TEXT,
  itemUrl,
  keywordFilter,
  limitWarning,
  resolveLimit,
  structuredResult,
  TEXT_COLS,
  textResult,
  TITLE_COL,
  validateEnum,
  yearRangeFilter,
} from "../src/tools/_shared.js";
import { interleave, tokenize, tokenizedWhere } from "../src/tools/search.js";
import type { Bindable } from "../src/db.js";
import { ALL_SUBSETS } from "../src/config.js";
import { at } from "./_must.js";

describe("countryParam", () => {
  it("omits Nigeria by default and includes it on demand, with an optional note", () => {
    const plain = countryParam().description ?? "";
    assert.ok(!plain.includes("Nigeria"));
    const withNigeria = countryParam({ nigeria: true, note: "test note" }).description ?? "";
    assert.ok(withNigeria.includes("Nigeria"));
    assert.ok(withNigeria.includes("test note"));
  });
});

describe("validateEnum", () => {
  it("returns {} when no value is supplied", () => {
    assert.deepEqual(validateEnum(undefined, COUNTRIES, "country"), {});
    assert.deepEqual(validateEnum("  ", COUNTRIES, "country"), {});
  });
  it("canonicalises accent/case variants", () => {
    assert.equal(validateEnum("cote d'ivoire", COUNTRIES, "country").canonical, "Côte d'Ivoire");
    assert.equal(validateEnum("BÉNIN", COUNTRIES, "country").canonical, "Benin");
    assert.equal(validateEnum(" niger ", COUNTRIES, "country").canonical, "Niger");
  });
  it("rejects unknown values with the full vocabulary", () => {
    const res = validateEnum("Atlantis", COUNTRIES, "country");
    assert.ok(res.err);
    assert.match(res.err.error, /Atlantis/);
    assert.deepEqual(res.err.valid_values, [...COUNTRIES]);
  });
});

describe("resolveLimit / limitWarning", () => {
  it("applies default and clamps to [1, max]", () => {
    assert.equal(resolveLimit(undefined, 20, 100).value, 20);
    assert.equal(resolveLimit(0, 20, 100).value, 1);
    assert.equal(resolveLimit(500, 20, 100).value, 100);
  });
  it("remembers the original request only when capped", () => {
    const capped = resolveLimit(500, 20, 100);
    assert.equal(capped.capped, true);
    const warn = limitWarning(capped);
    assert.equal(warn.requested_limit, 500);
    assert.match(String(warn.limit_warning), /maximum 100/);
    assert.deepEqual(limitWarning(resolveLimit(50, 20, 100)), {});
    assert.deepEqual(limitWarning(resolveLimit(undefined, 20, 100)), {});
  });
  // A per-call cap lower than the tool's documented maximum (search_articles
  // with `with_description`) is indistinguishable from a documentation bug
  // unless the warning says why it applied.
  it("carries the reason for a per-call maximum into the warning", () => {
    const warn = limitWarning(resolveLimit(100, 10, 25, "`with_description` adds a ~500-char abstract per row."));
    assert.match(String(warn.limit_warning), /maximum 25/);
    assert.match(String(warn.limit_warning), /with_description/);
    // No reason, no trailing sentence — the wording stays as it was.
    assert.equal(String(limitWarning(resolveLimit(500, 20, 100)).limit_warning).endsWith("applied 100."), true);
  });
  // The low end is a silent truncation too: one row returned for `limit: 0`
  // reads as "that is all there is".
  it("reports clamps at the LOW end as well", () => {
    for (const bad of [0, -5]) {
      const low = resolveLimit(bad, 20, 100);
      assert.equal(low.value, 1);
      assert.equal(low.capped, true, `limit ${bad} should be flagged as clamped`);
      const warn = limitWarning(low);
      assert.equal(warn.requested_limit, bad);
      assert.match(String(warn.limit_warning), /below the minimum 1/);
    }
  });
});

describe("itemUrl", () => {
  it("derives the canonical IWAC page from an o:id", () => {
    assert.equal(itemUrl(28576), "https://islam.zmo.de/s/afrique_ouest/item/28576");
    assert.equal(itemUrl("701"), "https://islam.zmo.de/s/afrique_ouest/item/701");
  });
});

describe("date range filters", () => {
  const schema = new Set(["pub_date"]);
  it("dateRangeFilter pads partial bounds to full days", () => {
    const where: string[] = [];
    const params: Bindable[] = [];
    dateRangeFilter(schema, where, params, "1995-06", "1999");
    assert.deepEqual(params, ["1995-06-01", "1999-12-31"]);
  });
  it("dateRangeFilter ignores garbage and missing columns", () => {
    const where: string[] = [];
    const params: Bindable[] = [];
    dateRangeFilter(schema, where, params, "garbage", undefined);
    assert.equal(where.length, 0);
    dateRangeFilter(new Set(), where, params, "1995", "1999");
    assert.equal(where.length, 0);
  });
  it("yearRangeFilter compares leading years numerically", () => {
    const where: string[] = [];
    const params: Bindable[] = [];
    yearRangeFilter(schema, where, params, "1912", "1999-06-15");
    assert.equal(where.length, 2);
    assert.deepEqual(params, [1912, 1999]);
  });
});

describe("keywordFilter", () => {
  it("ORs across the present text columns only", () => {
    const schema = new Set(["title", "OCR"]);
    const where: string[] = [];
    const params: Bindable[] = [];
    keywordFilter(schema, where, params, TEXT_COLS.articles, "charia");
    assert.equal(where.length, 1);
    assert.match(at(where, 0), /OR/);
    assert.deepEqual(params, ["%charia%", "%charia%"]); // descriptionAI absent
  });
  it("escapes LIKE metacharacters in the keyword", () => {
    const where: string[] = [];
    const params: Bindable[] = [];
    keywordFilter(new Set(["title"]), where, params, TEXT_COLS.articles, "100%_x");
    assert.deepEqual(params, ["%100\\%\\_x%"]);
    assert.match(at(where, 0), /ESCAPE/);
  });
  it("does nothing without a keyword", () => {
    const where: string[] = [];
    keywordFilter(new Set(["title"]), where, [], TEXT_COLS.articles, undefined);
    assert.equal(where.length, 0);
  });
});

describe("tokenizedWhere (unified search)", () => {
  it("ANDs tokens, ORs columns, binds params in lockstep", () => {
    const schema = new Set(["title", "OCR"]);
    const where: string[] = [];
    const params: Bindable[] = [];
    assert.equal(tokenizedWhere(schema, ["title", "OCR", "descriptionAI"], "pèlerinage Mecque", where, params), true);
    assert.equal(where.length, 2); // one clause per token
    assert.equal(params.length, 4); // two present columns per token
    assert.deepEqual(params, ["%pèlerinage%", "%pèlerinage%", "%Mecque%", "%Mecque%"]);
  });
  it("drops sub-2-char tokens and fails cleanly on nothing usable", () => {
    const schema = new Set(["title"]);
    assert.equal(tokenizedWhere(schema, ["title"], "a b", [], []), false);
    assert.equal(tokenizedWhere(new Set(), ["title"], "ramadan", [], []), false);
  });
});

describe("tokenize (unified search)", () => {
  it("keeps tokens of 2+ characters and drops the rest", () => {
    assert.deepEqual(tokenize("pèlerinage Mecque"), ["pèlerinage", "Mecque"]);
    assert.deepEqual(tokenize("  El   Hadj  "), ["El", "Hadj"]);
  });
  // The tool refuses these rather than answering count:0, which would be
  // indistinguishable from a term that is genuinely unattested.
  it("returns nothing for a query that is all sub-2-char words", () => {
    assert.deepEqual(tokenize("a"), []);
    assert.deepEqual(tokenize("a b c"), []);
    assert.deepEqual(tokenize("   "), []);
  });
});

describe("FAST_TEXT_COLS / HAS_HEAVY_TEXT (two-phase search)", () => {
  it("splits the cheap search surface from the full-text blobs", () => {
    // The fast pass must never touch OCR — that is the 1.8 s the split exists to avoid.
    for (const s of ALL_SUBSETS) {
      assert.ok(!FAST_TEXT_COLS[s].includes("OCR"), `${s} fast columns must exclude OCR`);
      for (const c of FAST_TEXT_COLS[s]) assert.ok(TEXT_COLS[s].includes(c), `${c} not in TEXT_COLS.${s}`);
    }
    assert.deepEqual(
      new Set(FAST_TEXT_COLS.articles),
      new Set(["title", "descriptionAI", "descriptionAI_en"]),
    );
    assert.deepEqual(new Set(FAST_TEXT_COLS.publications), new Set(["title", "subject", "tableOfContents"]));
  });
  it("flags exactly the subsets whose deep pass is worth running", () => {
    assert.equal(HAS_HEAVY_TEXT.articles, true);
    assert.equal(HAS_HEAVY_TEXT.publications, true);
    assert.equal(HAS_HEAVY_TEXT.documents, true);
    assert.equal(HAS_HEAVY_TEXT.audiovisual, true); // transcriptions
    // No full-text column: one pass covers everything they have.
    assert.equal(HAS_HEAVY_TEXT.index, false);
    assert.equal(HAS_HEAVY_TEXT.references, false);
    assert.equal(HAS_HEAVY_TEXT.images, false);
    for (const s of ALL_SUBSETS) {
      if (!HAS_HEAVY_TEXT[s]) {
        assert.deepEqual(new Set(FAST_TEXT_COLS[s]), new Set(TEXT_COLS[s]), `${s} should have no deep-only columns`);
      }
    }
  });
});

describe("interleave (unified search)", () => {
  const hit = (id: string) => ({ id, title: id, url: id, category: "articles" as const });
  it("round-robins across lists up to the limit", () => {
    const out = interleave([[hit("a1"), hit("a2")], [hit("b1")], [hit("c1"), hit("c2")]], 4);
    assert.deepEqual(out.map((h) => h.id), ["a1", "b1", "c1", "a2"]);
  });
  it("handles empty input and over-large limits", () => {
    assert.deepEqual(interleave([], 10), []);
    const out = interleave([[hit("a1")], [hit("b1")]], 10);
    assert.equal(out.length, 2);
  });
});

describe("textResult / structuredResult compaction", () => {
  it("drops null/empty-string object values, keeps arrays intact, converts bigints", () => {
    const payload = {
      keep: "x",
      empty: "",
      nul: null,
      big: 123n,
      zero: 0,
      arr: [1, 2n, ""],
      nested: { gone: "", stays: "y" },
    };
    const parsed = JSON.parse(at(textResult(payload).content, 0).text);
    assert.deepEqual(parsed, { keep: "x", big: 123, zero: 0, arr: [1, 2, ""], nested: { stays: "y" } });
  });
  it("scrubs control and private-use characters from strings", () => {
    const parsed = JSON.parse(at(textResult({ s: "a bc\td" }).content, 0).text);
    assert.equal(parsed.s, "abc\td"); // tab is legitimate OCR whitespace
  });
  it("structuredResult mirrors the text block exactly", () => {
    const payload = { n: 1, s: "x", drop: "", big: 9n, list: [{ a: "" }] };
    const res = structuredResult(payload);
    assert.deepEqual(JSON.parse(at(res.content, 0).text), res.structuredContent);
    assert.equal((res.structuredContent as Record<string, unknown>).big, 9);
    assert.equal("drop" in res.structuredContent, false);
  });
});

// The descriptor is now the single source for every projection, so these lock
// the invariants the old hand-maintained lists used to encode implicitly.
describe("SUBSET_FIELDS descriptor (colsFor / TEXT_COLS / TITLE_COL)", () => {
  // Every column of the synthetic fixtures, so nothing is dropped for absence.
  const FULL = {
    articles: new Set([
      "o:id", "iwac_url", "identifier", "title", "author", "newspaper", "country", "pub_date",
      "subject", "spatial", "language", "nb_pages", "descriptionAI",
      // Named for the default generation-2 model. Spelling them wrong here
      // would not fail — colsFor drops absent columns — so the projection
      // assertion below is what actually guards it.
      "claude_haiku_5_5_polarite",
      "claude_haiku_5_5_centralite_islam_musulmans",
      "claude_haiku_5_5_subjectivite_score", "nb_mots",
      "Richesse_Lexicale_OCR", "Lisibilite_OCR", "OCR",
    ]),
    index: new Set([
      "o:id", "iwac_url", "Titre", "Titre alternatif", "Type", "Description", "frequency",
      "first_occurrence", "last_occurrence", "countries",
    ]),
  } satisfies Record<string, Set<string>>;

  it("derives TITLE_COL from the field aliased to `title`", () => {
    assert.equal(TITLE_COL.articles, "title");
    assert.equal(TITLE_COL.index, "Titre"); // the one subset with a French title column
    for (const s of ALL_SUBSETS) assert.ok(TITLE_COL[s], `no title column for ${s}`);
  });

  it("gives audiovisual the transcription as its body, not the empty AI description", () => {
    const av = new Set(["o:id", "iwac_url", "title", "descriptionAI", "OCR", "medium"]);
    // descriptionAI is 0/47 filled in the real subset, so a `fetch` bodied on it
    // always answered "(no full text available)".
    assert.match(colsFor("audiovisual", av, "fetch"), /"OCR" AS "text"/);
    assert.match(colsFor("audiovisual", av, "detail"), /"OCR" AS "transcription"/);
    assert.ok(TEXT_COLS.audiovisual.includes("OCR"));
  });

  it("derives TEXT_COLS from the `searchable` tag", () => {
    // Set equality, not order: the OR-clause order is not semantic.
    assert.deepEqual(
      new Set(TEXT_COLS.articles),
      new Set(["title", "OCR", "descriptionAI", "descriptionAI_en"]),
    );
    assert.deepEqual(new Set(TEXT_COLS.index), new Set(["Titre", "Titre alternatif", "Description"]));
    // Every searchable column must be a real column name the schema can be probed for.
    for (const s of ALL_SUBSETS) {
      assert.ok(TEXT_COLS[s].length > 0, `${s} has no searchable columns`);
      for (const c of TEXT_COLS[s]) assert.ok(!c.includes('"'), `${c} is an expression, not a column`);
    }
  });

  it("keeps the English AI summary in the keyword-search surface", () => {
    // The dataset splits `bibo:shortDescription` into `descriptionAI` (fr) +
    // `descriptionAI_en` rather than pipe-joining the two @language literals.
    // If the English column ships to the Hub but never reaches TEXT_COLS, an
    // English query stops matching the summaries altogether — strictly worse
    // for anglophone discovery than the joined column was. This is that guard.
    let checked = 0;
    for (const s of ALL_SUBSETS) {
      if (!TEXT_COLS[s].includes("descriptionAI")) continue;
      checked++;
      assert.ok(
        TEXT_COLS[s].includes("descriptionAI_en"),
        `${s}.descriptionAI_en is not searchable`,
      );
      // Cheap half of the surface too: the unified `search` tries FAST_TEXT_COLS
      // first and only falls back to the OCR scan, so an English summary absent
      // from it would only be found on the slow path, if at all.
      assert.ok(
        FAST_TEXT_COLS[s].includes("descriptionAI_en"),
        `${s}.descriptionAI_en missing from the fast search pass`,
      );
    }
    assert.equal(checked, 3, "expected articles, documents and audiovisual");
  });

  it("searches the English summary but never returns it alongside the French one", () => {
    // One summary per response, not two: the pair says the same thing about the
    // same item, so returning both would double what an abstract costs to add
    // nothing. French is the returned one — source language, and the only one
    // present on every row. `views: []` is what encodes that.
    const schema = new Set(["o:id", "iwac_url", "descriptionAI", "descriptionAI_en"]);
    for (const s of ["articles", "documents", "audiovisual"] as const) {
      for (const v of ["detail", "fetch", "summary", "triage"] as const) {
        assert.ok(
          !colsFor(s, schema, v).includes("descriptionAI_en"),
          `${s}.${v} must not return the English summary`,
        );
      }
    }
    // The French one is still there — this is "pick one", not "drop both".
    assert.match(colsFor("articles", schema, "detail"), /"descriptionAI" AS "description_ai"/);
  });

  it("`fetch` re-aliases the body column to the contract key `text`", () => {
    assert.match(colsFor("articles", FULL.articles, "fetch"), /"OCR" AS "text"/);
    assert.match(colsFor("index", FULL.index, "fetch"), /"Description" AS "text"/);
    // …and every other view keeps the field's own alias.
    assert.match(colsFor("articles", FULL.articles, "detail"), /"OCR" AS "ocr_text"/);
  });

  it("keeps `fetch` leaner than `detail` while `detail` stays the superset", () => {
    const cols = (v: Parameters<typeof colsFor>[2]) => colsFor("articles", FULL.articles, v).split(", ").length;
    assert.ok(cols("detail") > cols("fetch"), "fetch should drop verbose/lexical fields");
    assert.ok(cols("detail") > cols("summary"), "summary should be leaner than detail");
    // `triage` is `summary` + the AI abstract (search_articles with_description).
    assert.equal(cols("triage"), cols("summary") + 1);
    assert.match(colsFor("articles", FULL.articles, "triage"), /"descriptionAI" AS "description_ai"/);
    assert.ok(!colsFor("articles", FULL.articles, "summary").includes("description_ai"));
  });

  it("gives the country-filtered index lists their `countries` column", () => {
    const list = colsFor("index", FULL.index, "list");
    const withCountries = colsFor("index", FULL.index, "listCountries");
    assert.ok(!list.includes("countries"));
    assert.ok(withCountries.includes('"countries"'));
    assert.equal(withCountries.split(", ").length, list.split(", ").length + 1);
  });

  it("projects the sentiment columns under short, model-agnostic aliases", () => {
    // The dataset column carries the model name; the output key must not, so a
    // rename upstream never reaches the caller's field names. Asserting the
    // real column name here is what would catch a stale prefix in the
    // descriptor — colsFor silently drops anything the schema lacks.
    const detail = colsFor("articles", FULL.articles, "detail");
    assert.match(detail, /claude_haiku_5_5_polarite AS "polarity"/);
    assert.match(detail, /claude_haiku_5_5_centralite_islam_musulmans AS "centrality"/);
    assert.match(detail, /claude_haiku_5_5_subjectivite_score AS "subjectivity"/);
  });

  it("drops columns missing from the live schema instead of throwing", () => {
    const thin = new Set(["o:id", "title"]);
    const cols = colsFor("articles", thin, "summary");
    assert.equal(cols, '"o:id" AS "id", "title"');
  });
});

// The registry is the ONE place a sentiment model or column prefix is named, so
// these guard the invariant that survives the next campaign: a handle either
// names a model this server serves, or fails loudly. Nothing in between.
