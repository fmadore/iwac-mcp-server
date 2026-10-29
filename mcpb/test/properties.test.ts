// Property-based checks on the text helpers whose bugs were silent: a fold
// that shifts offsets (U+0130 once moved every later excerpt by one), an
// excerpt search that misses what SQL just matched, a keyword split that
// invents or drops terms. fast-check generates the inputs a hand-written case
// list forgets: transliteration marks, mixed normalization, the dotted capital I.
import { describe, it } from "node:test";
import fc from "fast-check";

import { extractMatchingTocEntries, foldText, keywordExcerpts, keywordTerms } from "../src/tools/_shared.js";

/** Characters the archive's French press and Arabic transliteration actually use. */
const ARCHIVE_CHARS = [..."aàâäeéèêëiîïoôöuùûücçœæAÉÈÇŒİIıẞßḥḤṣṢṭẓāīūĀĪŪʿʾ'’-«» ., ;:\n0123456789"];
const archiveText = fc.string({ unit: fc.constantFrom(...ARCHIVE_CHARS), maxLength: 400 });
const anyText = fc.oneof(archiveText, fc.string({ unit: "grapheme", maxLength: 200 }));

describe("foldText", () => {
  it("keeps the length of NFC text, so fold offsets are text offsets", () => {
    fc.assert(
      fc.property(anyText, (raw) => {
        const text = raw.normalize("NFC");
        return foldText(text).length === text.length;
      }),
    );
  });

  it("is invariant under Unicode normalization", () => {
    fc.assert(fc.property(anyText, (text) => foldText(text.normalize("NFD")) === foldText(text.normalize("NFC"))));
  });
});

describe("keywordExcerpts", () => {
  it("always finds a needle cut from the text, as typed or folded", () => {
    fc.assert(
      fc.property(archiveText, fc.nat(), fc.integer({ min: 1, max: 12 }), fc.boolean(), (raw, at, size, fold) => {
        const text = raw.normalize("NFC");
        const start = text.length ? at % text.length : 0;
        const cut = text.slice(start, start + size);
        fc.pre(cut.trim().length > 0);
        const needle = fold ? foldText(cut) : cut;
        return keywordExcerpts(text, needle).match_count >= 1;
      }),
    );
  });
});

describe("keywordTerms", () => {
  it("never yields an empty term and only yields text the keyword contains", () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom(...ARCHIVE_CHARS, '"', "\t"), maxLength: 80 }), (keyword) =>
        keywordTerms(keyword).every((term) => term.length > 0 && keyword.includes(term)),
      ),
    );
  });

  it("reads a keyword without whitespace or quotes as one term in every mode", () => {
    const word = fc.string({ unit: fc.constantFrom(..."abcéèçœİḥ-'"), minLength: 1, maxLength: 20 });
    fc.assert(
      fc.property(word, (keyword) =>
        [undefined, "literal", "all_terms"].every((mode) => {
          const terms = keywordTerms(keyword, mode as "literal" | "all_terms" | undefined);
          return terms.length === 1 && terms[0] === keyword;
        }),
      ),
    );
  });
});

describe("extractMatchingTocEntries", () => {
  it("returns only entries of the table of contents", () => {
    fc.assert(
      fc.property(fc.array(archiveText, { maxLength: 8 }), archiveText, (entries, needle) => {
        const toc = entries.join("\n\n");
        const kept = extractMatchingTocEntries(toc, needle);
        const all = new Set(toc.split(/\n\n+/).map((s) => s.trim()));
        return kept === "" || kept.split("\n\n").every((entry) => all.has(entry));
      }),
    );
  });
});
