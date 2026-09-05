import type { ChartOnlyData, ChartModelPayload, ChartPayload, ViewName } from "../../viewContract.js";
import { structuredResult, viewResult } from "./results.js";

/** Check known chart fields at construction without changing the wire schema. */
export function chartResult<K extends ViewName>(
  payload: { view: K } & NoInfer<ChartPayload<K>> & Record<string, unknown>,
) {
  return structuredResult(payload);
}

/** Model summaries cannot accidentally include the chart-only fields. */
export function chartViewResult<K extends keyof ChartOnlyData>(
  payload: { view: K } & NoInfer<ChartModelPayload<K>> & Record<string, unknown>,
  viewData: NoInfer<ChartOnlyData[K]>,
) {
  return viewResult(payload, viewData);
}
