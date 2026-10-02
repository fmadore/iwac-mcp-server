import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModelContext } from "../src/app/modelContext.js";
import type { BasePayload, ViewResult } from "../src/app/shell.js";

const view: ViewResult = { title: "Sources in the selection", subtitle: "2 matching items", body: "<svg>PRIVATE BODY</svg>", notes: ["Archive coverage is incomplete."] };

test("model context includes filters, source identities, display options and snapshot, without bodies or arbitrary fields", () => {
  const result = buildModelContext({
    view: "records", subset: "articles", mode: "concordance", total_matches: 2,
    filters: { country: "Benin", keyword: "pèlerinage", keyword_aliases: ["hadj"], exact: { spatial: ["Cotonou"], "polarity:luna": ["Neutre"], password: ["SECRET"] }, token: "SECRET" },
    rows: [{ id: "articles:101", text: "FULL OCR", contexts: ["FULL CONTEXT"] }, { id: "articles:102" }],
    provenance: { snapshot_id: "a".repeat(64), analysis_version: "iwac-research-v2", datasets: { articles: { repository: "fmadore/iwac", revision: "commit1", files: ["PRIVATE PATH"], token: "SECRET" } } },
    export: { content: "WHOLE EXPORT" }, text: "FULL OCR", points: [{ x: 1, y: 2 }],
  }, { metric: "fulltext", timeline: false, token: "SECRET" }, view);
  const summary = result.structuredContent;
  assert.deepEqual(summary.source_ids, ["articles:101", "articles:102"]);
  assert.deepEqual(summary.display, { metric: "fulltext", timeline: false });
  assert.deepEqual(summary.selection, { country: "Benin", keyword: "pèlerinage", keyword_aliases: ["hadj"], exact: { spatial: ["Cotonou"], "polarity:luna": ["Neutre"] } });
  assert.equal((summary.dataset as Record<string, unknown>).snapshot_id, "a".repeat(64));
  const encoded = JSON.stringify(result);
  for (const omitted of ["PRIVATE BODY", "FULL OCR", "FULL CONTEXT", "PRIVATE PATH", "WHOLE EXPORT", "SECRET", '"points"']) assert.ok(!encoded.includes(omitted), omitted);
  assert.match(result.content[0].text, /Sources in the selection/);
  assert.match(result.content[0].text, /Archive coverage is incomplete/);
  assert.equal(summary.truncated, true, "unknown selection fields are explicitly omitted");
});

test("model context preserves both comparison selections and the actual selected sentiment pair", () => {
  const comparison = buildModelContext({ view: "comparison", subset: "articles", filters: { country: "Benin" }, selections: [
    { label: "A", filters: { country: "Benin", date_from: "1990" }, total: 12, fulltext: 8 },
    { label: "B", filters: { country: "Togo", exact: { subject: ["Islam"] } }, total: 9 },
  ] }, {}, view).structuredContent;
  assert.deepEqual(comparison.comparison_selections, [
    { label: "A", filters: { country: "Benin", date_from: "1990" }, total: 12, fulltext: 8 },
    { label: "B", filters: { country: "Togo", exact: { subject: ["Islam"] } }, total: 9 },
  ]);
  const sentiment = buildModelContext({ view: "sentiment", model: "all", agreement_matrix: {
    rows: "luna", cols: "gemma", field: "centrality", common_scored: 98, excluded_articles: 2, agreement_percent: 45,
    counts: { Central: { Marginal: 8 } }, notes: ["UNBOUNDED MATRIX NOTE"],
  } }, {}, view).structuredContent;
  assert.deepEqual(sentiment.sentiment, { model: "all", pair: { rows: "luna", cols: "gemma", field: "centrality", common_scored: 98, excluded_articles: 2, agreement_percent: 45 } });
  assert.ok(!JSON.stringify(sentiment).includes("UNBOUNDED MATRIX NOTE"));
});

test("model context never exports coordinates or full chart arrays and bounds source identity sampling", () => {
  const payload: BasePayload = { view: "semanticMap", subset: "references", points: Array.from({ length: 10_000 }, (_, index) => ({ id: String(index + 1), x: 999, y: 888, vector: [1, 2, 3] })) };
  const result = buildModelContext(payload, { layout: "network" }, view);
  assert.equal((result.structuredContent.source_ids as string[]).length, 20);
  assert.equal((result.structuredContent.source_ids as string[])[0], "references:1");
  assert.equal(result.structuredContent.source_rows_in_view, 10_000);
  assert.equal(result.structuredContent.truncated, true);
  assert.ok(!(JSON.stringify(result).includes('"x"')));
  assert.ok(!(JSON.stringify(result).includes('"vector"')));
  const reader = buildModelContext({ view: "reader", id: "documents:42", text: "PRIVATE FULL TEXT" }, {}, view);
  assert.deepEqual(reader.structuredContent.source_ids, ["documents:42"]);
});

test("oversized Unicode notes and filters remain below 12 kB and explicitly warn about truncated selections", () => {
  const long = "🕌è\\\n".repeat(10_000);
  const filters = { keyword: long, keyword_aliases: Array(12).fill(long), exact: Object.fromEntries(Array.from({ length: 20 }, (_, n) => [`polarity:model_${n}`, Array(20).fill(long)])) };
  const result = buildModelContext({
    view: "comparison", subset: "articles", note: long,
    selections: [{ label: "A", total: 1, filters }, { label: "B", total: 2, filters }],
    provenance: { snapshot_id: "a".repeat(64), analysis_version: long, datasets: Object.fromEntries(["articles", "publications", "documents", "audiovisual", "images", "index", "references"].map((subset) => [subset, { repository: long, revision: long }])) },
  }, { metric: long }, { title: long, subtitle: long, notes: Array(20).fill(long), body: long });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 12_000, String(Buffer.byteLength(JSON.stringify(result))));
  assert.equal(result.structuredContent.truncated, true);
  assert.match(String(result.structuredContent.truncation_note), /truncated filters/);
  assert.equal((result.structuredContent.comparison_selections as unknown[]).length, 2);
  assert.ok((result.structuredContent.truncated_fields as string[]).length <= 12);
});

test("untrusted payload fields cannot smuggle nested objects through primitive whitelists", () => {
  const result = buildModelContext({ view: "records", subset: "articles", total_matches: Number.NaN, filters: { country: { secret: "SECRET" }, keyword: ["SECRET"] }, rows: [{ id: "javascript:SECRET" }] }, { metric: { secret: "SECRET" } }, view);
  assert.ok(!JSON.stringify(result).includes("SECRET"));
  assert.equal((result.structuredContent.counts as Record<string, unknown> | undefined)?.total_matches, undefined);
  assert.equal(result.structuredContent.source_ids, undefined);
});

test("encoded control characters and enormous unused arrays cannot exceed the package cap", () => {
  const long = "\u0001".repeat(10_000);
  const result = buildModelContext({
    view: "comparison", subset: "articles", note: long,
    selections: ["A", "B"].map((label) => ({ label, total: 1, filters: { keyword: long, country: long, newspaper: long, subject: long, date_from: long, date_to: long, keyword_mode: long } })),
    provenance: { snapshot_id: "a".repeat(64), analysis_version: long, datasets: { articles: { repository: long, revision: long }, references: { repository: long, revision: long } } },
  }, { metric: long }, { title: long, subtitle: long, notes: Array(100_000).fill(long), body: long });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 12_000);
  const textOnly = { content: [{ type: "text", text: `${result.content[0].text}\n${JSON.stringify(result.structuredContent)}` }] };
  assert.ok(Buffer.byteLength(JSON.stringify(textOnly)) <= 11_000);
  assert.equal(result.structuredContent.truncated, true);
  assert.equal((result.structuredContent.comparison_selections as unknown[]).length, 2);
  const unknown = buildModelContext({ view: "reader", id: "42", text: "not a confirmed articles ID" }, {}, view);
  assert.equal(unknown.structuredContent.source_ids, undefined);
});

test("pathological escaped base fields terminate with a bounded, explicitly truncated context", () => {
  const long = "\u0001".repeat(100_000);
  const payload: BasePayload = Object.fromEntries(["view", "subset", "mode", "field", "calendar", "granularity", "group_by", "normalize_by", "color_by", "has_more"].map((key) => [key, long]));
  payload.filters = { exact: { scored_by: ["luna", "gemma"] } };
  const result = buildModelContext(payload, {}, { title: long, subtitle: long, body: long, notes: [long] });
  const textOnly = { content: [{ type: "text", text: `${result.content[0].text}\n${JSON.stringify(result.structuredContent)}` }] };
  assert.ok(Buffer.byteLength(JSON.stringify(textOnly)) <= 11_000);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 11_000);
  assert.equal(result.structuredContent.truncated, true);
});
