import { deepEqual, equal } from "node:assert/strict";
import { test } from "node:test";
import { isViewName, VIEW_DATA_META_KEY } from "../src/viewContract.js";
import { chartResult, chartViewResult } from "../src/tools/shared/chartResults.js";
import { pending } from "../src/app/shell.js";
import { renderView, VIEWS, type ViewRegistry } from "../src/app/views/index.js";
import { coverageView } from "../src/app/views/research.js";
import { at } from "./_must.js";

test("split chart results keep coordinates out of model content", () => {
  const points = [{ id: "1", x: 0.5, y: 0.25 }];
  const result = chartViewResult({ view: "semanticMap", projected: 1, groups: { Togo: 1 } }, { points });
  deepEqual(result._meta[VIEW_DATA_META_KEY], { points });
  equal("points" in result.structuredContent, false);
  deepEqual(JSON.parse(at(result.content, 0).text), result.structuredContent);
});

test("view dispatch rejects unknown and inherited object keys", () => {
  equal(isViewName("topics"), true);
  equal(isViewName("toString"), false);
  equal(isViewName("unknown"), false);
});

test("typed dispatch renders by tag and refuses unknown or inherited tags", () => {
  const reader = renderView({ view: "reader", id: "articles:1", title: "Source", text: "Texte", url: "https://islam.zmo.de/s/afrique_ouest/item/1" }, {});
  equal(reader?.title, "Source");
  // Corpus text is marked French for the press subset; the chrome stays English.
  equal(reader?.body.includes('class="source-text" lang="fr"'), true);
  equal(renderView({ view: "toString" }, {}), undefined);
  equal(renderView({ view: "unknown" }, {}), undefined);
  equal(renderView({}, {}), undefined);
});

test("the pending state escapes arguments and lifts a nested selection into chips", () => {
  const html = pending("get_temporal_distribution", { subset: "articles", selection: { keyword: "<script>" } });
  equal(html.includes('role="status"'), true);
  equal(html.includes("Computing temporal distribution"), true);
  equal(html.includes("keyword: &#60;script&#62;"), true);
  equal(html.includes("<script>"), false);
  equal(pending(undefined, undefined).includes("Computing the result"), true);
});

// Checked by tsc, never executed: ensure the shared contract constrains writers.
function invalidPayloads() {
  // @ts-expect-error Workbench views require a selection and counted rows.
  chartResult({view:"coverage",rows:"not rows"});
  // @ts-expect-error A source reader requires its canonical URL.
  chartResult({view:"reader",id:"articles:1",title:"Source",text:"text"});
  // @ts-expect-error Counts must be numbers, even inside topic rows.
  chartResult({ view: "topics", topics: [{ count: "one" }] });
  // @ts-expect-error Dense coordinates belong in chart data, not model summaries.
  chartViewResult({ view: "semanticMap", points: [] }, { points: [] });
  // @ts-expect-error A semantic map cannot receive a topic series as chart data.
  chartViewResult({ view: "semanticMap" }, { series_by_topic: {} });
}
void invalidPayloads;

// Checked by tsc, never executed: a renderer wired to another tag's payload
// fails to compile instead of drawing an empty chart.
function invalidRegistry(): ViewRegistry {
  // @ts-expect-error The reader tag cannot be served by the coverage renderer.
  return { ...VIEWS, reader: coverageView };
}
void invalidRegistry;
