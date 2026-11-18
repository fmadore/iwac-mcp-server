// Unit tests for the text helpers: accent folding, LIKE escaping, excerpt caps,
// reading a long body in parts on code-point boundaries, keyword excerpts and
// table-of-contents matching. Split from the former test/unit.test.ts
// (November 2026); `npm run test:unit` runs it (tsx --test).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  attachOcrOrExcerpts,
  capText,
  codePointBoundary,
  escapeLike,
  extractMatchingTocEntries,
  foldText,
  keywordExcerpts,
  pagedBody,
  pageText,
} from "../src/tools/_shared.js";
import { at } from "./_must.js";

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
  // "\u0130".toLowerCase() is "i\u0307" (two units): the only code point whose
  // lowercase is longer, so each occurrence used to shift later excerpt offsets.
  it("keeps dotted capital I (U+0130) index-stable, folding it to i like SQL", () => {
    assert.equal(foldText("\u0130stanbul"), "istanbul");
    const text = `${"\u0130".repeat(400)} ${"x".repeat(300)} Maouloud ${"y".repeat(300)}`;
    assert.equal(foldText(text).length, text.length);
    const { excerpts } = keywordExcerpts(text, "maouloud", { contextChars: 200 });
    assert.ok(excerpts[0]?.includes("Maouloud"), `excerpt drifted off the match: ${excerpts[0]}`);
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

describe("capText", () => {
  it("passes short text through untouched", () => {
    assert.deepEqual(capText("hello"), { text: "hello", truncated: false });
  });
  it("caps long text and says so", () => {
    const capped = capText("x".repeat(30_000));
    assert.equal(capped.text.length, 25_000);
    assert.equal(capped.truncated, true);
    assert.match(String(capped.truncation_message), /from 30000 to 25000/);
  });
});

// The cap alone left everything past 25,000 characters reachable only through
// keyword excerpts: most publication issues and the longest transcriptions
// could not be read whole however the user asked.
describe("reading a long body in parts", () => {
  // Each character's position is recoverable, so a gap or overlap shows.
  const body = Array.from({ length: 60_010 }, (_, i) => String.fromCharCode(0x4e00 + (i % 2000))).join("");

  it("follows next_offset to the end without gaps or overlap", () => {
    let read = "";
    let offset: number | undefined = 0;
    let parts = 0;
    while (offset !== undefined) {
      const page = pageText(body, offset);
      assert.equal(page.offset, offset);
      assert.equal(page.char_count, body.length);
      read += page.text;
      offset = page.next_offset;
      parts++;
    }
    assert.equal(parts, 3);
    assert.equal(read, body);
  });

  it("never starts or ends a part inside a surrogate pair", () => {
    const emoji = "\u{1F54C}".repeat(20_000); // 40,000 UTF-16 units
    const first = pageText(emoji);
    assert.equal(first.next_offset, 25_000);
    const odd = pageText(emoji, 25_001);
    assert.equal(odd.offset, 25_000, "an offset on a low surrogate moves back to the pair's start");
    assert.equal(first.text + odd.text, emoji);
  });

  it("keeps a short body exactly as before: no paging fields", () => {
    assert.deepEqual(pagedBody("court", "ocr_text", undefined), { ocr_text: "court" });
  });

  it("says where it stopped and how to read on", () => {
    const first = pagedBody(body, "ocr_text", undefined);
    assert.equal(first.char_count, 60_010);
    assert.equal(first.next_offset, 25_000);
    assert.equal(first.offset, undefined);
    assert.equal(first.truncated, true);
    assert.match(String(first.truncation_message), /offset 25000/);
    const last = pagedBody(body, "ocr_text", 50_000);
    assert.equal(last.offset, 50_000);
    assert.equal(last.next_offset, undefined);
    assert.equal(last.truncated, undefined, "the last part is not truncated");
    assert.equal(String(last.ocr_text).length, 10_010);
  });

  it("reports an offset past the end instead of an empty body", () => {
    const past = pagedBody(body, "ocr_text", 60_010);
    assert.equal("ocr_text" in past, false);
    assert.match(String(past.note), /past the end .*60010 characters/);
  });

  it("keeps the body key in place on a detail row", () => {
    const row: Record<string, unknown> = { id: 1, ocr_text: body, url: "u" };
    attachOcrOrExcerpts(row, "ocr_text", undefined, { offset: 25_000 });
    assert.deepEqual(Object.keys(row).slice(0, 3), ["id", "ocr_text", "url"]);
    assert.equal(row.offset, 25_000);
  });

  it("says an offset beside a keyword changed nothing", () => {
    const row: Record<string, unknown> = { ocr_text: `${"a ".repeat(20_000)}Maouloud` };
    attachOcrOrExcerpts(row, "ocr_text", "maouloud", { offset: 30_000 });
    assert.equal(row.match_count, 1);
    assert.match(String(row.parameter_note), /offset ignored/);
  });
});

// String.slice counts UTF-16 units. Cutting between the two halves of an
// emoji left a lone surrogate that JSON serialises as an escape like "\udd4c".
describe("cutting text on code-point boundaries", () => {
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  it("moves a cut off the second half of a surrogate pair", () => {
    const s = "a\u{1F54C}b"; // a, mosque emoji (2 units), b
    assert.equal(codePointBoundary(s, 2), 1);
    assert.equal(codePointBoundary(s, 1), 1);
    assert.equal(codePointBoundary(s, 3), 3);
    assert.equal(codePointBoundary(s, 0), 0);
    assert.equal(codePointBoundary(s, s.length), s.length);
  });
  it("keeps capText and keyword excerpts free of lone surrogates", () => {
    const capped = capText(`a${"\u{1F54C}".repeat(20)}`, { limit: 10 });
    assert.ok(capped.truncated);
    assert.doesNotMatch(capped.text, loneSurrogate);
    const text = `${"\u{1F54C}".repeat(150)} Maouloud ${"\u{1F54C}".repeat(150)}`;
    for (const contextChars of [200, 201, 202, 203]) {
      const excerpt = at(keywordExcerpts(text, "maouloud", { contextChars }).excerpts, 0);
      assert.match(excerpt, /Maouloud/);
      assert.doesNotMatch(excerpt, loneSurrogate, `contextChars ${contextChars}`);
    }
  });
});

describe("keywordExcerpts", () => {
  it("matches accent-insensitively and returns original text", () => {
    const ocr = "Début. Le pèlerinage à La Mecque commence. Fin.";
    const res = keywordExcerpts(ocr, "pelerinage");
    assert.equal(res.match_count, 1);
    assert.equal(res.excerpts_returned, 1);
    assert.match(at(res.excerpts, 0), /pèlerinage/);
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
