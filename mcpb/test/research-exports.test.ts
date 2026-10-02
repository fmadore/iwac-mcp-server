import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { bibliography, citationItem, citationProjection, researchExport } from "../src/tools/researchExports.js";
import { concordanceContexts } from "../src/tools/research/concordance.js";
import { comparisonTimeline } from "../src/tools/research/comparison.js";

test("citation exports preserve known metadata without inferring missing names, dates or degree types", () => {
  const book = citationItem("references", {
    id: "references:1", url: "https://example.org/1", title: "Le Bénin", author: "Kadiri, Aïcha|Collectif",
    type: "Livre", date: "1999", publisher: "Éditions du Golfe",
  });
  assert.equal(book.type, "book");
  assert.deepEqual(book.author, [{ literal: "Kadiri, Aïcha" }, { literal: "Collectif" }]);
  assert.deepEqual(book.issued, { "date-parts": [[1999]] });
  assert.equal(book.DOI, undefined);
  const unknown = citationItem("publications", { id: "publications:2", title: "Numéro", date: "2024-02-31" });
  assert.equal(unknown.type, "document");
  assert.equal(unknown.author, undefined);
  assert.equal(unknown.issued, undefined);
  assert.equal(unknown.note, "Stored date: 2024-02-31");
  const thesis = bibliography([citationItem("references", { id: "references:3", type: "Mémoire" })]);
  assert.ok(thesis.startsWith("@misc{"), "a stored thesis label does not establish a doctoral degree");
  assert.deepEqual(citationItem("articles", { id: "articles:4", date: "2024-02" }).issued, { "date-parts": [[2024, 2]] });
});

test("BibTeX preserves literal names and escapes metadata with hostile syntax", () => {
  const bib = bibliography([citationItem("articles", {
    id: "articles:10", title: "{Title} & 50% _ \\input{x}", author: "Research and Development|Smith, John",
    date: "2024-02-29", url: "https://example.org/a_b",
  })]);
  assert.match(bib, /^@article\{iwac-articles:10,/);
  assert.ok(bib.includes("author = {{Research and Development} and {Smith, John}}"));
  assert.ok(bib.includes("\\{Title\\} \\& 50\\% \\_ \\textbackslash{}input\\{x\\}"));
  assert.ok(bib.includes("date = {2024-02-29}"));
  assert.ok(bib.includes("url = {https://example.org/a\\_b}"));
});

test("manifest identifies its exact page and the projection excludes body/model blobs", () => {
  const projection = citationProjection("references", new Set(["o:id", "title", "pub_date", "author", "abstract", "embedding_OCR", "doi"]));
  assert.ok(projection.includes('"doi"'));
  assert.ok(!projection.includes("abstract"));
  assert.ok(!projection.includes("embedding"));
  const result = researchExport("manifest", "articles", [{ id: "articles:101", url: "https://example.org/101" }], { country: "Benin" }, { offset: 20, limit: 1, total_matches: 100 });
  const manifest = JSON.parse(result.content);
  assert.equal(manifest.offset, 20);
  assert.equal(manifest.returned, 1);
  assert.equal(manifest.has_more, true);
  assert.equal(manifest.records[0].id, "articles:101");
  assert.deepEqual(manifest.selection, { country: "Benin" });
  assert.match(manifest.provenance.snapshot_id, /^[0-9a-f]{64}$/);
});

test("concordance source offsets survive accents/astral characters and reject unreliable normalization offsets", () => {
  const source = "🕌 Le pèlerinage arrive. Le PÈLERINAGE repart.";
  const data = concordanceContexts(source, ["pelerinage", "PÈLERINAGE", "  "], "OCR");
  assert.equal(data.match_count, 2, "fold-equivalent aliases do not double-count occurrences");
  assert.deepEqual(data.matched_terms, ["pelerinage"]);
  const context = data.contexts[0];
  assert.equal(context.offset_unit, "utf16");
  assert.equal(source.slice(context.start, context.end), context.match);
  assert.equal(data.source_field, "OCR");
  assert.equal(data.source_text_sha256, createHash("sha256").update(source).digest("hex"));
  const decomposed = concordanceContexts("Un pe\u0300lerinage ancien", ["pèlerinage"], "OCR");
  assert.equal(decomposed.match_count, 1);
  assert.equal(decomposed.source_offsets_available, false);
  assert.equal(decomposed.contexts[0].start, undefined);
  assert.equal(decomposed.contexts[0].match, "pèlerinage");
});

test("concordance bounded storage handles blank input and counts long repeated OCR", () => {
  assert.equal(concordanceContexts("some text", ["", " \n\t"], "OCR").match_count, 0);
  const data = concordanceContexts("hadj ".repeat(100_000), ["hadj"], "OCR");
  assert.equal(data.match_count, 100_000);
  assert.equal(data.contexts.length, 3);
  assert.equal(data.excerpts.length, 3);
});

test("temporal comparison uses a common corpus denominator within the union of the requested date scopes", async () => {
  const source = `(SELECT * FROM (VALUES ('1995-06-15','Benin'),('1995-10-15','Togo'),('1995','Benin'),
    ('1996/1997','Benin'),('bad-date','Benin'),('2000','Togo'),('','Togo')) t(pub_date,country))`;
  const schema = new Set(["pub_date", "country"]);
  const scoped = await comparisonTimeline("articles", schema, source,
    { country: "Benin", date_from: "1995-06", date_to: "1995-06" },
    { country: "Togo", date_from: "1995-10", date_to: "1995-10" });
  assert.deepEqual(scoped?.rows, [
    { selection: "A", year: "1995", count: 2, denominator: 3, share: 2 / 3 },
    { selection: "B", year: "1995", count: 1, denominator: 3, share: 1 / 3 },
  ]);
  const all = await comparisonTimeline("articles", schema, source, { country: "Benin" }, { country: "Togo" });
  assert.ok(all?.rows.some((row) => row.year === "(undated)"));
  assert.ok(all?.rows.some((row) => row.year === "(invalid date)"));
  assert.ok(all?.rows.some((row) => row.year === "(multiyear)"));
  assert.ok(all?.rows.every((row) => row.count <= row.denominator));
  assert.equal(await comparisonTimeline("index", new Set(["Titre"]), source, {}, {}), undefined);
});
