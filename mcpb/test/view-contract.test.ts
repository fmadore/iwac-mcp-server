import { deepEqual, equal } from "node:assert/strict";
import { test } from "node:test";
import { isViewName, VIEW_DATA_META_KEY } from "../src/viewContract.js";
import { chartResult, chartViewResult } from "../src/tools/shared/chartResults.js";

test("split chart results keep coordinates out of model content", () => {
  const points = [{ id: "1", x: 0.5, y: 0.25 }];
  const result = chartViewResult({ view: "semanticMap", projected: 1, groups: { Togo: 1 } }, { points });
  deepEqual(result._meta[VIEW_DATA_META_KEY], { points });
  equal("points" in result.structuredContent, false);
  deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
});

test("view dispatch rejects unknown and inherited object keys", () => {
  equal(isViewName("topics"), true);
  equal(isViewName("toString"), false);
  equal(isViewName("unknown"), false);
});

// Checked by tsc, never executed: ensure the shared contract constrains writers.
function invalidPayloads() {
  // @ts-expect-error Counts must be numbers, even inside topic rows.
  chartResult({ view: "topics", topics: [{ count: "one" }] });
  // @ts-expect-error Dense coordinates belong in chart data, not model summaries.
  chartViewResult({ view: "semanticMap", points: [] }, { points: [] });
  // @ts-expect-error A semantic map cannot receive a topic series as chart data.
  chartViewResult({ view: "semanticMap" }, { series_by_topic: {} });
}
void invalidPayloads;
