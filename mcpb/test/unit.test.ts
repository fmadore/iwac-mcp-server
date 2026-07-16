// Unit tests for the pure helpers — the logic that encodes this server's
// historical bug classes (accent folding, excerpt caps, date normalisation,
// silent-zero validation, result compaction, tokenization). Runs offline in
// milliseconds: `npm run test:unit` (tsx --test).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  capText,
  COUNTRIES,
  countryParam,
  dateRangeFilter,
  escapeLike,
  extractMatchingTocEntries,
  foldText,
  keywordExcerpts,
  keywordFilter,
  limitWarning,
  resolveLimit,
  rowsToMap,
  structuredResult,
  TEXT_COLS,
  textResult,
  validateEnum,
  yearRangeFilter,
} from "../src/tools/_shared.js";
import { interleave, tokenizedWhere } from "../src/tools/search.js";
import { q, selectList } from "../src/db.js";

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
    const params: unknown[] = [];
    dateRangeFilter(schema, where, params, "1995-06", "1999");
    assert.equal(where.length, 2);
    assert.deepEqual(params, ["1995-06-01", "1999-12-31"]);
  });
  it("dateRangeFilter ignores garbage and missing columns", () => {
    const where: string[] = [];
    const params: unknown[] = [];
    dateRangeFilter(schema, where, params, "garbage", undefined);
    assert.equal(where.length, 0);
    dateRangeFilter(new Set(), where, params, "1995", "1999");
    assert.equal(where.length, 0);
  });
  it("yearRangeFilter compares leading years numerically", () => {
    const where: string[] = [];
    const params: unknown[] = [];
    yearRangeFilter(schema, where, params, "1912", "1999-06-15");
    assert.equal(where.length, 2);
    assert.deepEqual(params, [1912, 1999]);
  });
});

describe("keywordFilter", () => {
  it("ORs across the present text columns only", () => {
    const schema = new Set(["title", "OCR"]);
    const where: string[] = [];
    const params: (string | number | boolean | null)[] = [];
    keywordFilter(schema, where, params, TEXT_COLS.articles, "charia");
    assert.equal(where.length, 1);
    assert.match(where[0], /OR/);
    assert.deepEqual(params, ["%charia%", "%charia%"]); // descriptionAI absent
  });
  it("escapes LIKE metacharacters in the keyword", () => {
    const where: string[] = [];
    const params: (string | number | boolean | null)[] = [];
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
    const params: unknown[] = [];
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
