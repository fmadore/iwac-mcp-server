// Unit tests for the pure helpers — the logic that encodes this server's
// historical bug classes (accent folding, excerpt caps, date normalisation,
// silent-zero validation, result compaction, tokenization). Runs offline in
// milliseconds: `npm run test:unit` (tsx --test).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { bubbleMap, columns, donut, forceGraph, gantt, heatmapMatrix, horizontalBar, squarify, ticks, treemap } from "../src/app/svg.js";
import { BASEMAP, BASEMAP_BOUNDS } from "../src/app/basemap.js";
import { project2d } from "../src/pca.js";
import { csv, csvCell } from "../src/app/shell.js";
import { fmtInt, THOUSANDS_SEP } from "../src/app/theme.js";
import { carryFilters, temporalView } from "../src/app/views/temporal.js";
import { lunarView } from "../src/app/views/lunar.js";
import { VIEWS } from "../src/app/views/index.js";
import { VIEW } from "../src/tools/appUi.js";

import {
  capText,
  colsFor,
  COUNTRIES,
  countryParam,
  dateRangeFilter,
  escapeLike,
  extractMatchingTocEntries,
  FAST_TEXT_COLS,
  foldText,
  HAS_HEAVY_TEXT,
  HIJRI_MONTHS,
  hijriFilter,
  itemUrl,
  keywordExcerpts,
  keywordFilter,
  limitWarning,
  requireHijriColumns,
  resolveHijriMonth,
  resolveLimit,
  rowsToMap,
  structuredResult,
  TEXT_COLS,
  textResult,
  TITLE_COL,
  validateEnum,
  yearRangeFilter,
} from "../src/tools/_shared.js";
import { interleave, tokenize, tokenizedWhere } from "../src/tools/search.js";
import { q, selectList, type Bindable } from "../src/db.js";
import { ALL_SUBSETS } from "../src/config.js";

describe("foldText", () => {
  it("folds accents and case", () => {
    assert.equal(foldText("Pèlerinage À la MECQUE"), "pelerinage a la mecque");
    assert.equal(foldText("Côte d'Ivoire"), "cote d'ivoire");
    assert.equal(foldText("Événements"), "evenements");
  });
  it("is index-stable for NFC input (one UTF-16 unit per unit)", () => {
    for (const s of ["Pèlerinage à Ouagadougou", "Événements — côte ø æ", "laïcité"]) {
      assert.equal(foldText(s).length, s.length, `length changed for ${s}`);
    }
  });
  it("folds decomposed (NFD) accents like SQL strip_accents does", () => {
    const nfd = "pe\u0300lerinage"; // e + combining grave accent (decomposed \u00e8)
    assert.equal(foldText(nfd), "pelerinage");
    assert.equal(foldText(nfd), foldText("p\u00e8lerinage"));
  });
  // Latin Extended Additional (U+1E00-U+1EFF). DuckDB's strip_accents folds this
  // block, so the JS fold must too or the excerpt path reports "not found" for an
  // item the SQL search just matched. These are the transliteration characters of
  // the corpus: scholarly Arabic (Mu\u1e25ammad, \u1e25ad\u012bth, \u1e62\u016bf\u012b) and Yoruba/Igbo (\u1eb8, \u1ecd, \u1e63).
  it("folds Latin Extended Additional the way SQL strip_accents does", () => {
    assert.equal(foldText("Mu\u1e25ammad"), "muhammad");
    assert.equal(foldText("\u1e25ad\u012bth"), "hadith");
    assert.equal(foldText("\u1e62\u016bf\u012b"), "sufi");
    assert.equal(foldText("\u1eb8gb\u1eb9\u0301 \u1eccm\u1ecd Od\u00f9duw\u00e0"), "egbe\u0301 omo oduduwa");
    // Same length in, same length out \u2014 keywordExcerpts slices the ORIGINAL
    // string at offsets found in the folded one.
    for (const s of ["Mu\u1e25ammad", "\u1e62\u016bf\u012b", "\u1ecdm\u1ecd"]) {
      assert.equal(foldText(s).length, s.length, `length changed for ${s}`);
    }
  });
});

describe("escapeLike", () => {
  it("escapes %, _ and backslash", () => {
    assert.equal(escapeLike("100%"), "100\\%");
    assert.equal(escapeLike("al_islam"), "al\\_islam");
    assert.equal(escapeLike("a\\b"), "a\\\\b");
    assert.equal(escapeLike("plain"), "plain");
  });
});

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

describe("capText", () => {
  it("passes short text through untouched", () => {
    assert.deepEqual(capText("hello"), { text: "hello", truncated: false });
  });
  it("caps long text and points at the keyword path when asked", () => {
    const long = "x".repeat(30_000);
    const capped = capText(long, { suggestKeyword: true });
    assert.equal(capped.text.length, 25_000);
    assert.equal(capped.truncated, true);
    assert.match(String(capped.truncation_message), /keyword/);
  });
});

describe("keywordExcerpts", () => {
  it("matches accent-insensitively and returns original text", () => {
    const ocr = "Début. Le pèlerinage à La Mecque commence. Fin.";
    const res = keywordExcerpts(ocr, "pelerinage");
    assert.equal(res.match_count, 1);
    assert.equal(res.excerpts_returned, 1);
    assert.match(res.excerpts[0], /pèlerinage/);
  });
  it("caps the number of excerpts but reports the true match count", () => {
    // 50 matches spaced far enough apart that no excerpt window covers two.
    const ocr = Array.from({ length: 50 }, () => `ramadan${" x".repeat(1500)}`).join("");
    const res = keywordExcerpts(ocr, "ramadan");
    assert.equal(res.match_count, 50);
    assert.ok(res.excerpts_returned <= 10, `expected <=10 excerpts, got ${res.excerpts_returned}`);
    assert.equal(res.truncated, true);
    assert.match(String(res.truncation_message), /50 matches/);
  });
  it("skips matches already visible in the previous excerpt", () => {
    const ocr = `${"a".repeat(100)}ramadan${"b".repeat(50)}ramadan${"c".repeat(3000)}`;
    const res = keywordExcerpts(ocr, "ramadan", { contextChars: 2000 });
    assert.equal(res.match_count, 2);
    assert.equal(res.excerpts_returned, 1);
  });
  it("reports a miss with a note", () => {
    const res = keywordExcerpts("nothing here", "ramadan");
    assert.equal(res.match_count, 0);
    assert.match(String(res.note), /not found/);
  });
  it("reports out-of-range excerpt parameters instead of silently clamping", () => {
    const ocr = `${"a".repeat(50)}ramadan${"b".repeat(50)}`;
    const res = keywordExcerpts(ocr, "ramadan", { maxExcerpts: -3, contextChars: 99_999 });
    assert.equal(res.excerpts_returned, 1);
    assert.match(String(res.parameter_note), /max_excerpts -3 clamped to 1/);
    assert.match(String(res.parameter_note), /context_chars 99999 clamped to 5000/);
    // In-range values say nothing.
    assert.equal(keywordExcerpts(ocr, "ramadan", { maxExcerpts: 5 }).parameter_note, undefined);
    assert.equal(keywordExcerpts(ocr, "ramadan").parameter_note, undefined);
  });
});

describe("extractMatchingTocEntries", () => {
  it("filters paragraph entries accent-insensitively", () => {
    const toc = "Editorial: la charia au Sahel\n\nDossier: le pèlerinage 1995\n\nBrèves diverses";
    assert.equal(extractMatchingTocEntries(toc, "PELERINAGE"), "Dossier: le pèlerinage 1995");
    assert.equal(extractMatchingTocEntries(toc, "absent"), "");
  });
});

describe("date range filters", () => {
  const schema = new Set(["pub_date"]);
  it("dateRangeFilter pads partial bounds to full days", () => {
    const where: string[] = [];
    const params: Bindable[] = [];
    dateRangeFilter(schema, where, params, "1995-06", "1999");
    assert.equal(where.length, 2);
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
    assert.match(where[0], /OR/);
    assert.deepEqual(params, ["%charia%", "%charia%"]); // descriptionAI absent
  });
  it("escapes LIKE metacharacters in the keyword", () => {
    const where: string[] = [];
    const params: Bindable[] = [];
    keywordFilter(new Set(["title"]), where, params, TEXT_COLS.articles, "100%_x");
    assert.deepEqual(params, ["%100\\%\\_x%"]);
    assert.match(where[0], /ESCAPE/);
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
    assert.deepEqual(new Set(FAST_TEXT_COLS.articles), new Set(["title", "descriptionAI"]));
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
    const parsed = JSON.parse(textResult(payload).content[0].text);
    assert.deepEqual(parsed, { keep: "x", big: 123, zero: 0, arr: [1, 2, ""], nested: { stays: "y" } });
  });
  it("scrubs control and private-use characters from strings", () => {
    const parsed = JSON.parse(textResult({ s: "a bc\td" }).content[0].text);
    assert.equal(parsed.s, "abc\td"); // tab is legitimate OCR whitespace
  });
  it("structuredResult mirrors the text block exactly", () => {
    const payload = { n: 1, s: "x", drop: "", big: 9n, list: [{ a: "" }] };
    const res = structuredResult(payload);
    assert.deepEqual(JSON.parse(res.content[0].text), res.structuredContent);
    assert.equal((res.structuredContent as Record<string, unknown>).big, 9);
    assert.equal("drop" in res.structuredContent, false);
  });
});

// The descriptor is now the single source for every projection, so these lock
// the invariants the old hand-maintained lists used to encode implicitly.
describe("SUBSET_FIELDS descriptor (colsFor / TEXT_COLS / TITLE_COL)", () => {
  // Every column of the synthetic fixtures, so nothing is dropped for absence.
  const FULL: Record<string, Set<string>> = {
    articles: new Set([
      "o:id", "iwac_url", "identifier", "title", "author", "newspaper", "country", "pub_date",
      "subject", "spatial", "language", "nb_pages", "descriptionAI",
      // Named for the model that scored the corpus, per the 2026-07-31 dataset
      // rename. Spelling them wrong here would not fail — colsFor drops absent
      // columns — so the projection assertion below is what actually guards it.
      "gemini_3_flash_preview_polarite",
      "gemini_3_flash_preview_centralite_islam_musulmans",
      "gemini_3_flash_preview_subjectivite_score", "nb_mots",
      "Richesse_Lexicale_OCR", "Lisibilite_OCR", "OCR",
    ]),
    index: new Set([
      "o:id", "iwac_url", "Titre", "Titre alternatif", "Type", "Description", "frequency",
      "first_occurrence", "last_occurrence", "countries",
    ]),
  };

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
    assert.deepEqual(new Set(TEXT_COLS.articles), new Set(["title", "OCR", "descriptionAI"]));
    assert.deepEqual(new Set(TEXT_COLS.index), new Set(["Titre", "Titre alternatif", "Description"]));
    // Every searchable column must be a real column name the schema can be probed for.
    for (const s of ALL_SUBSETS) {
      assert.ok(TEXT_COLS[s].length > 0, `${s} has no searchable columns`);
      for (const c of TEXT_COLS[s]) assert.ok(!c.includes('"'), `${c} is an expression, not a column`);
    }
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
    assert.match(detail, /gemini_3_flash_preview_polarite AS "polarity"/);
    assert.match(detail, /gemini_3_flash_preview_centralite_islam_musulmans AS "centrality"/);
    assert.match(detail, /gemini_3_flash_preview_subjectivite_score AS "subjectivity"/);
  });

  it("drops columns missing from the live schema instead of throwing", () => {
    const thin = new Set(["o:id", "title"]);
    const cols = colsFor("articles", thin, "summary");
    assert.equal(cols, '"o:id" AS "id", "title"');
  });
});

describe("db helpers", () => {
  it("q quotes identifiers and doubles embedded quotes", () => {
    assert.equal(q("Titre alternatif"), '"Titre alternatif"');
    assert.equal(q('we"ird'), '"we""ird"');
  });
  it("selectList keeps only columns present in the schema", () => {
    const schema = new Set(["title", "o:id", "pub_date"]);
    const sql = selectList(schema, [
      ['"o:id"', "id", ["o:id"]],
      "title",
      "missing",
      ["pub_date", "date", ["pub_date"]],
      ["expr", "gone", ["absent_col"]],
    ]);
    assert.equal(sql, '"o:id" AS "id", "title", pub_date AS "date"');
  });
  it("rowsToMap skips empty keys and coerces counts", () => {
    const rows = [
      { k: "Benin", c: 5n },
      { k: "", c: 3 },
      { k: null, c: 2 },
      { k: "Togo", c: "7" },
    ];
    assert.deepEqual(rowsToMap(rows as Record<string, unknown>[]), { Benin: 5, Togo: 7 });
  });
});

// -----------------------------------------------------------------------------
// MCP App chart kernel (src/app/*) — pure string/geometry helpers, so they test
// in Node with no DOM. test/app.test.mjs covers the DOM-and-transport half by
// booting the real bundle.
// -----------------------------------------------------------------------------

describe("chart kernel", () => {
  it("ticks round the axis up to a 1/2/5 step", () => {
    assert.deepEqual(ticks(97), { max: 100, values: [0, 25, 50, 75, 100] });
    assert.deepEqual(ticks(3), { max: 3, values: [0, 1, 2, 3] });
    // A degenerate peak must still produce a drawable axis rather than NaNs.
    assert.deepEqual(ticks(0), { max: 1, values: [0, 1] });
    assert.equal(ticks(12287).max >= 12287, true);
  });

  it("squarify covers the rect exactly and keeps input order", () => {
    const rect = { x: 0, y: 0, w: 400, h: 200 };
    const values = [50, 30, 12, 5, 3];
    const boxes = squarify(values, rect);
    assert.equal(boxes.length, values.length);
    const area = boxes.reduce((a, b) => a + b.w * b.h, 0);
    assert.ok(Math.abs(area - rect.w * rect.h) < 1, `area ${area} != ${rect.w * rect.h}`);
    // Bigger value => bigger cell, and every cell stays inside the rect.
    assert.ok(boxes[0].w * boxes[0].h > boxes[4].w * boxes[4].h);
    for (const b of boxes) {
      assert.ok(b.x >= -0.01 && b.y >= -0.01, "cell starts outside the rect");
      assert.ok(b.x + b.w <= rect.w + 0.01 && b.y + b.h <= rect.h + 0.01, "cell overflows the rect");
    }
  });

  it("squarify degrades safely on empty or zero input", () => {
    assert.deepEqual(squarify([], { x: 0, y: 0, w: 10, h: 10 }), []);
    const zero = squarify([0, 0], { x: 0, y: 0, w: 10, h: 10 });
    assert.equal(zero.length, 2);
    assert.ok(zero.every((b) => b.w === 0 && b.h === 0));
  });

  it("charts escape data into markup", () => {
    // A newspaper title with an ampersand or quote must not break out of the
    // attribute it lands in; nothing here is ever set as HTML by the host.
    const svg = horizontalBar({
      items: [{ label: '"Le <b>Soir</b>" & co', value: 3 }],
      ariaLabel: "test",
      clickable: true,
    });
    assert.ok(!svg.includes("<b>"), "unescaped markup leaked into the chart");
    assert.ok(svg.includes("&#38;"), "ampersand was not escaped");
    assert.ok(!/data-key="[^"]*"[^>]*"/.test(svg.split("data-key=")[1]?.slice(0, 60) ?? ""));
  });

  it("donut renders one arc per non-zero slice and totals the centre", () => {
    const svg = donut({ slices: [{ label: "positive", value: 3 }, { label: "neutral", value: 0 }, { label: "negative", value: 1 }] });
    assert.equal((svg.match(/<path/g) ?? []).length, 2);
    assert.ok(svg.includes(">4<"), "centre value should default to the total");
    assert.ok(svg.includes("75%"), "slice tooltip should carry the share");
  });

  it("donut and treemap return nothing rather than an empty frame", () => {
    assert.equal(donut({ slices: [] }), "");
    assert.equal(treemap({ items: [] }), "");
    assert.equal(columns({ categories: [], series: [] }), "");
    assert.equal(gantt({ rows: [] }), "");
    assert.equal(heatmapMatrix({ rows: [], cols: [], values: [] }), "");
  });

  it("gantt places a single-year run inside the plot", () => {
    const svg = gantt({ rows: [{ label: "Islam Info", start: 2000, end: 2000, weight: 695 }] });
    assert.ok(svg.includes("Islam Info"));
    assert.ok(svg.includes("695 issues"));
    assert.ok(!svg.includes("NaN"), "degenerate span produced NaN geometry");
  });

  it("heatmap leaves non-finite cells empty instead of drawing rgb(NaN)", () => {
    const svg = heatmapMatrix({ rows: ["a", "b"], cols: ["a", "b"], values: [[Number.NaN, 2], [2, Number.NaN]] });
    assert.equal((svg.match(/<rect/g) ?? []).length, 2);
    assert.ok(!svg.includes("NaN"));
  });

  it("csv quotes delimiters and defuses formula injection", () => {
    assert.equal(csv([["year", "count"], [1999, 3]]), "year,count\r\n1999,3");
    assert.equal(csvCell('Le "Soir", Cotonou'), '"Le ""Soir"", Cotonou"');
    assert.equal(csvCell("=1+1"), "'=1+1");
    assert.equal(csvCell(null), "");
  });

  it("fmtInt groups thousands without depending on the iframe locale", () => {
    assert.equal(fmtInt(12287), `12${THOUSANDS_SEP}287`);
    assert.equal(THOUSANDS_SEP, " ", "the separator should be a narrow no-break space");
    assert.equal(fmtInt(7), "7");
    assert.equal(fmtInt(-1200), `-1${THOUSANDS_SEP}200`);
  });

  it("the temporal view carries filters forward and discloses undated items", () => {
    const result = temporalView({
      view: "temporal",
      subset: "articles",
      granularity: "year",
      filters: { country: "Togo", keyword: null },
      total_matches: 10,
      dated_count: 8,
      undated_count: 2,
      distribution: { 1999: 3, 2000: 5 },
    });
    assert.match(result.title, /articles per year/);
    assert.ok(result.body.includes("<svg"));
    assert.ok(result.notes?.some((n) => typeof n === "string" && n.includes("no usable date")));
    // Null filters must not travel back to the server as explicit nulls.
    assert.deepEqual(carryFilters({ filters: { country: "Togo", keyword: null, subject: "" } }), { country: "Togo" });
  });

  it("the server's view tags and the app's view registry agree", () => {
    // The two halves ship in different bundles and cannot import each other at
    // runtime, so a tool stamping a tag no view renders — or a view nothing
    // ever reaches — would only show up as a blank panel in Claude.
    for (const [tag, view] of Object.entries(VIEWS)) {
      assert.equal(typeof view, "function", `view ${tag} is not a function`);
    }
    assert.deepEqual(Object.keys(VIEWS).sort(), Object.values(VIEW).sort());
  });
});

// -----------------------------------------------------------------------------
// The place map's geometry. A projection bug is invisible in a rendered chart
// unless you already know where these cities are, so it is asserted instead.
// -----------------------------------------------------------------------------

describe("place map", () => {
  /** Ray casting in lon/lat space — the basemap rings are plain [lng, lat]. */
  function inRing(lng: number, lat: number, ring: [number, number][]): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  const countryAt = (lng: number, lat: number): string | undefined =>
    BASEMAP.find((c) => c.rings.some((r) => inRing(lng, lat, r)))?.name;

  it("the simplified outline still puts real cities in the right country", () => {
    // Coordinates as the IWAC index geocodes them.
    const cities: [string, number, number, string][] = [
      ["Ouagadougou", -1.53388, 12.36566, "Burkina Faso"],
      ["Abidjan", -4.0083, 5.3364, "Côte d'Ivoire"],
      ["Cotonou", 2.4183, 6.3654, "Benin"],
      ["Niamey", 2.1098, 13.5116, "Niger"],
      ["Lagos", 3.3792, 6.5244, "Nigeria"],
      ["Bamako", -8.0029, 12.6392, "Mali"],
    ];
    for (const [name, lng, lat, expected] of cities) {
      assert.equal(countryAt(lng, lat), expected, `${name} fell in the wrong country`);
    }
  });

  it("the basemap covers the six IWAC countries and stays small", () => {
    const iwac = BASEMAP.filter((c) => c.iwac).map((c) => c.name).sort();
    assert.deepEqual(iwac, ["Benin", "Burkina Faso", "Côte d'Ivoire", "Niger", "Nigeria", "Togo"]);
    // It is inlined into every .mcpb; the simplification is what makes a map
    // possible under the app CSP at all.
    const points = BASEMAP.reduce((a, c) => a + c.rings.reduce((x, r) => x + r.length, 0), 0);
    assert.ok(points < 1200, `basemap has ${points} points; re-run scripts/make-basemap.mjs with a coarser tolerance`);
  });

  it("bubbles are area-proportional and clipped to the frame", () => {
    const svg = bubbleMap({
      countries: BASEMAP,
      bounds: BASEMAP_BOUNDS,
      points: [
        { label: "Ouagadougou", lat: 12.37, lng: -1.53, value: 1624 },
        { label: "Lomé", lat: 6.13, lng: 1.22, value: 406 },
        // Mecca is one of the most-named places in the corpus and is nowhere
        // near this frame; it must be dropped, not drawn at the edge.
        { label: "La Mecque", lat: 21.42, lng: 39.83, value: 1649 },
      ],
    });
    assert.equal((svg.match(/<circle/g) ?? []).length, 2, "an out-of-frame point was drawn");
    assert.ok(!svg.includes("La Mecque"));
    // 4x the count => 2x the radius, because area carries the value.
    const radii = [...svg.matchAll(/r="([\d.]+)"/g)].map((m) => Number(m[1]));
    const [big, small] = radii;
    assert.ok(Math.abs((big - 3) / (small - 3) - 2) < 0.05, `radii ${radii} are not area-proportional`);
  });
});

describe("co-mention network", () => {
  const NODES = Array.from({ length: 12 }, (_, i) => ({ label: `n${i}`, weight: 100 - i * 5 }));
  // Two tight clusters, plus one bridge between them.
  const EDGES = [
    ...[0, 1, 2].flatMap((i) => [0, 1, 2].filter((j) => j > i).map((j) => ({ source: i, target: j, weight: 50 }))),
    ...[6, 7, 8].flatMap((i) => [6, 7, 8].filter((j) => j > i).map((j) => ({ source: i, target: j, weight: 50 }))),
    { source: 2, target: 6, weight: 5 },
  ];

  it("is deterministic — the same data always draws the same picture", () => {
    // A graph that reshuffles on every re-render cannot be read as evidence.
    const a = forceGraph({ nodes: NODES, edges: EDGES });
    const b = forceGraph({ nodes: NODES, edges: EDGES });
    assert.equal(a, b);
  });

  it("places tightly-linked nodes closer than unlinked ones", () => {
    const svg = forceGraph({ nodes: NODES, edges: EDGES });
    const at = (i: number) => {
      const circles = [...svg.matchAll(/<circle cx="([\d.-]+)" cy="([\d.-]+)"/g)];
      return { x: Number(circles[i][1]), y: Number(circles[i][2]) };
    };
    const d = (i: number, j: number) => Math.hypot(at(i).x - at(j).x, at(i).y - at(j).y);
    // Within-cluster distance must beat the across-cluster distance, or the
    // layout is telling the reader nothing.
    assert.ok(d(0, 1) < d(0, 7), `cluster mates ${d(0, 1).toFixed(0)} apart, rivals ${d(0, 7).toFixed(0)}`);
    assert.ok(d(6, 7) < d(6, 1));
    assert.ok(!svg.includes("NaN"));
  });

  it("survives degenerate inputs", () => {
    assert.equal(forceGraph({ nodes: [], edges: [] }), "");
    // One node, no edges: no division by zero, no NaN geometry.
    const solo = forceGraph({ nodes: [{ label: "only", weight: 1 }], edges: [] });
    assert.ok(solo.includes("<circle"));
    assert.ok(!solo.includes("NaN"));
    // Zero weights everywhere must not produce infinite radii.
    const flat = forceGraph({ nodes: [{ label: "a", weight: 0 }, { label: "b", weight: 0 }], edges: [{ source: 0, target: 1, weight: 0 }] });
    assert.ok(!flat.includes("NaN") && !flat.includes("Infinity"));
  });
});

describe("PCA projection", () => {
  it("recovers a planted 2-D structure from high-dimensional noise", () => {
    // Points on a known plane inside 40 dimensions, plus small noise on the
    // rest. PC1/PC2 must recover the plane and explain nearly all the variance.
    const D = 40;
    const vectors = [];
    for (let i = 0; i < 60; i++) {
      const a = Math.cos((i / 60) * Math.PI * 2) * 10;
      const b = Math.sin((i / 60) * Math.PI * 2) * 4;
      const v = new Array(D).fill(0).map((_, j) => (j % 7) * 1e-4 * ((i % 5) - 2));
      v[3] = a;
      v[17] = b;
      vectors.push(v);
    }
    const { points, explained } = project2d(vectors);
    assert.equal(points.length, 60);
    assert.ok(explained[0] + explained[1] > 0.99, `explained ${explained} should be ~1 for a planar cloud`);
    // The wider axis must come first.
    assert.ok(explained[0] > explained[1]);
    // The ring's shape survives: the spread along PC1 is ~10/4 that along PC2.
    const spread = (k: number) => Math.max(...points.map((p) => p[k])) - Math.min(...points.map((p) => p[k]));
    assert.ok(Math.abs(spread(0) / spread(1) - 2.5) < 0.3, `aspect ${spread(0) / spread(1)}`);
  });

  it("is deterministic and sign-stable", () => {
    const vectors = Array.from({ length: 30 }, (_, i) =>
      Array.from({ length: 12 }, (_, j) => Math.sin(i * 0.7 + j) + (j === 2 ? i : 0)),
    );
    const a = project2d(vectors);
    const b = project2d(vectors);
    assert.deepEqual(a.points, b.points, "two runs on identical data must agree, including sign");
  });

  it("degrades safely", () => {
    assert.deepEqual(project2d([]).points, []);
    assert.deepEqual(project2d([[1, 2, 3]]).points, [[0, 0]]);
    // Identical vectors: zero variance, no NaN, no divide-by-zero.
    const same = project2d([
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
    ]);
    assert.equal(same.points.length, 3);
    assert.ok(same.points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
    assert.deepEqual(same.explained, [0, 0]);
  });
});

// -----------------------------------------------------------------------------
// Hijri (Umm al-Qura) inputs. The columns are precomputed by the pipeline, so
// the server's job is resolving what the model typed and refusing to guess.
// -----------------------------------------------------------------------------

describe("resolveHijriMonth", () => {
  it("accepts the month number", () => {
    assert.equal(resolveHijriMonth("9").n, 9);
    assert.equal(resolveHijriMonth("1").n, 1);
    assert.equal(resolveHijriMonth("12").n, 12);
  });

  it("accepts the academic transliteration the archive uses", () => {
    assert.equal(resolveHijriMonth("Ramadan").n, 9);
    assert.equal(resolveHijriMonth("Dhu al-Hijja").n, 12);
    assert.equal(resolveHijriMonth("Muharram").n, 1);
  });

  it("accepts the French forms the INSTRUCTIONS ask the model to query in", () => {
    // The server tells the model to formulate queries in French, so refusing
    // French month names would be refusing its own house style.
    assert.equal(resolveHijriMonth("Chaabane").n, 8);
    assert.equal(resolveHijriMonth("Chawwal").n, 10);
    assert.equal(resolveHijriMonth("Mouharram").n, 1);
    assert.equal(resolveHijriMonth("Dhou al-hijja").n, 12);
  });

  it("folds case and accents like every other filter", () => {
    assert.equal(resolveHijriMonth("RAMADAN").n, 9);
    assert.equal(resolveHijriMonth("  ramadan  ").n, 9);
    assert.equal(resolveHijriMonth("sha'ban").n, 8);
    assert.equal(resolveHijriMonth("Shaban").n, 8);
  });

  it("accepts common alternates a non-francophone user reaches for", () => {
    assert.equal(resolveHijriMonth("Rabi al-awwal").n, 3);
    assert.equal(resolveHijriMonth("Dhul-Hijjah").n, 12);
    assert.equal(resolveHijriMonth("Ramadhan").n, 9);
  });

  it("treats an absent value as no filter", () => {
    assert.deepEqual(resolveHijriMonth(undefined), {});
    assert.deepEqual(resolveHijriMonth("  "), {});
  });

  it("errors with valid_values rather than filtering to zero rows", () => {
    // A typo that returned 0 articles would be indistinguishable from a real
    // absence, which is the whole reason enum inputs are validated here.
    for (const bad of ["Ramadam", "0", "13", "-1", "Frimaire"]) {
      const r = resolveHijriMonth(bad);
      assert.equal(r.n, undefined, `${bad} should not resolve`);
      const err = r.err as { error: string; valid_values: string[] };
      assert.match(err.error, /Invalid hijri_month/);
      assert.equal(err.valid_values.length, 12);
      assert.ok(err.valid_values.includes("Ramadan"));
    }
  });

  it("resolves every month in the canonical table", () => {
    HIJRI_MONTHS.forEach((name, i) => {
      assert.equal(resolveHijriMonth(name).n, i + 1, `${name} should be month ${i + 1}`);
    });
  });
});

describe("requireHijriColumns", () => {
  it("passes when both columns are present", () => {
    const schema = new Set(["pub_date", "hijri_year", "hijri_month", "hijri_day"]);
    assert.equal(requireHijriColumns(schema, "articles"), undefined);
  });

  it("explains the absence instead of letting SQL fail on an unbound column", () => {
    const r = requireHijriColumns(new Set(["pub_date"]), "references");
    assert.ok(r, "missing columns should be reported");
    assert.match(r.error, /hijri_year, hijri_month/);
    assert.match(r.error, /references/);
    // The note has to name which subsets DO carry lunar dates, or the model
    // retries the same call on the same subset.
    assert.match(r.note, /not references/);
  });

  it("reports only the column that is actually missing", () => {
    const r = requireHijriColumns(new Set(["pub_date", "hijri_year"]), "articles");
    assert.ok(r);
    assert.match(r.error, /hijri_month/);
    assert.doesNotMatch(r.error, /hijri_year/);
  });
});

describe("hijriFilter", () => {
  it("binds month and year as parameters", () => {
    const where: string[] = [];
    const params: Bindable[] = [];
    hijriFilter(where, params, 9, 1445);
    assert.deepEqual(where, ["hijri_month = ?", "hijri_year = ?"]);
    assert.deepEqual(params, [9, 1445]);
  });

  it("adds nothing when neither is given", () => {
    const where: string[] = [];
    const params: Bindable[] = [];
    hijriFilter(where, params, undefined, undefined);
    assert.deepEqual(where, []);
    assert.deepEqual(params, []);
  });

  it("filters on one axis independently of the other", () => {
    const w1: string[] = [];
    const p1: Bindable[] = [];
    hijriFilter(w1, p1, 9, undefined);
    assert.deepEqual(w1, ["hijri_month = ?"]);
    assert.deepEqual(p1, [9]);

    const w2: string[] = [];
    const p2: Bindable[] = [];
    hijriFilter(w2, p2, undefined, 1445);
    assert.deepEqual(w2, ["hijri_year = ?"]);
    assert.deepEqual(p2, [1445]);
  });
});

describe("lunarView", () => {
  const payload = {
    view: "lunar",
    subset: "articles",
    granularity: "lunar_month",
    calendar: "hijri",
    total_matches: 120,
    dated_count: 100,
    imprecise_date_count: 20,
    month_labels: Object.fromEntries(HIJRI_MONTHS.map((m, i) => [String(i + 1).padStart(2, "0"), m])),
    distribution: { "01": 5, "07": 10, "09": 60, "11": 25 },
  };

  /** The x-axis text, in order, with the renderer's escaping undone. */
  function axisOf(body: string): string[] {
    return [...body.matchAll(/class="tick" text-anchor="middle">([^<]+)</g)].map((m) =>
      m[1].replaceAll("&#39;", "'"),
    );
  }

  it("plots all twelve months even where a month is empty", () => {
    // A gap in the lunar year is a finding; dropping the bar would hide it, so
    // every month must hold an axis slot whether or not it has items.
    const axis = axisOf(lunarView(payload).body);
    assert.equal(axis.length, 12);
    // Ramadan (60 items) and Dhu al-Hijja (0) both appear.
    assert.ok(axis.includes("Ramadan"));
    assert.ok(axis.includes("Hijja"));
  });

  it("draws the even-split reference line the chart exists to compare against", () => {
    const v = lunarView(payload);
    assert.match(v.body, /class="refline"/);
    assert.match(v.body, /even split/);
  });

  it("names the peak month and its deviation in a note", () => {
    const notes = (lunarView(payload).notes ?? []).filter(Boolean).join(" ");
    assert.match(notes, /Ramadan leads at 60/);
    assert.match(notes, /\+\d+%/);
  });

  it("reports imprecisely dated items as absent, not zero", () => {
    const notes = (lunarView(payload).notes ?? []).filter(Boolean).join(" ");
    assert.match(notes, /20 matching items carry a date too imprecise/);
    assert.match(notes, /not zero/);
  });

  it("offers to read the peak month's items", () => {
    const peak = (lunarView(payload).actions ?? []).find((a) => a.id === "peak");
    assert.ok(peak, "the peak action should exist");
    assert.match(peak.label, /Ramadan/);
  });

  it("routes the peak action to the subset's own search tool", () => {
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const ctx = {
      run: (tool: string, args: Record<string, unknown>) => void calls.push({ tool, args }),
      download: () => undefined,
    } as never;
    const actions = lunarView({ ...payload, subset: "publications" }).actions ?? [];
    actions.find((a) => a.id === "peak")?.run(ctx);
    assert.equal(calls[0].tool, "search_publications");
    assert.equal(calls[0].args.hijri_month, "09");
  });

  it("survives an empty distribution", () => {
    const v = lunarView({ view: "lunar", subset: "articles", distribution: {} });
    assert.ok(v.body.length > 0);
    assert.doesNotMatch(v.body, /NaN/);
  });

  // The measured distribution over the 12,220 fully-dated articles — every
  // month occupied, so every bar carries a tooltip.
  const REAL = [739, 667, 968, 738, 735, 725, 777, 877, 1747, 1462, 1052, 1733];
  const realPayload = {
    ...payload,
    distribution: Object.fromEntries(REAL.map((n, i) => [String(i + 1).padStart(2, "0"), n])),
  };

  it("shortens only the two labels that would collide, and only on the axis", () => {
    // Twelve labels share ~70 viewBox units each; "Dhu al-Qa'da" beside
    // "Dhu al-Hijja" measured as overlapping (a -0.9px gap). Shortening is
    // confined to the axis so the tooltip still gives the full name.
    const body = lunarView(realPayload).body.replaceAll("&#39;", "'");
    const axis = axisOf(lunarView(realPayload).body);
    assert.deepEqual(axis.slice(10), ["Qa'da", "Hijja"], "the two Dhu al- months should be shortened");
    assert.ok(!axis.includes("Dhu al-Qa'da"), "the long form should not reach the axis");
    // …but the full names still identify the bars.
    assert.match(body, /<title>Dhu al-Qa'da: /);
    assert.match(body, /<title>Dhu al-Hijja: /);
    // Every other month keeps its full name on the axis.
    assert.deepEqual(axis.slice(0, 10), HIJRI_MONTHS.slice(0, 10));
  });

  it("labels at most four bars directly", () => {
    // A number on every bar is the noise selective labelling exists to avoid:
    // 8 of these 12 months deviate by >=25%, which must fall back to the top 4.
    const direct = [...lunarView(realPayload).body.matchAll(/class="barlbl"/g)].length;
    assert.ok(direct > 0 && direct <= 4, `expected 1-4 direct labels, got ${direct}`);
  });
});
