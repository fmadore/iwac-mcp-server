import { VIEW, isViewName, type ChartPayload, type ChartPayloads, type ViewName } from "../../viewContract.js";
// The view registry: payload `view` tag → renderer.
//
// Adding a chart means adding a module here and setting the matching `view`
// tag on the tool's payload. The tags live in src/viewContract.ts (`VIEW`) so
// the server side cannot drift from this map silently, and test/charts.unit.test.ts
// asserts the two sets agree; the registry also checks every tag at compile time.
import type { BasePayload, View, ViewOptions, ViewResult } from "../shell.js";
import { collectionView } from "./collection.js";
import { cooccurrenceView } from "./cooccurrence.js";
import { countriesView } from "./countries.js";
import { fieldView } from "./field.js";
import { lexicalView } from "./lexical.js";
import { lunarView } from "./lunar.js";
import { newspapersView } from "./newspapers.js";
import { periodicalsView } from "./periodicals.js";
import { placesView } from "./places.js";
import { semanticMapView } from "./semanticMap.js";
import { sentimentView } from "./sentiment.js";
import { similarView } from "./similar.js";
import { temporalView } from "./temporal.js";
import { topicsView } from "./topics.js";

import { recordsView, readerView, coverageView, comparisonView, attentionView } from "./research.js";

/**
 * Each tag maps to a renderer typed against THAT tag's contract payload, so a
 * renderer wired to the wrong tag (a coverage view under `reader`) fails to
 * compile rather than drawing an empty chart.
 */
export type ViewRegistry = { readonly [K in ViewName]: View<ChartPayloads[K]> };

export const VIEWS: ViewRegistry = {
  [VIEW.records]: recordsView,
  [VIEW.reader]: readerView,
  [VIEW.coverage]: coverageView,
  [VIEW.comparison]: comparisonView,
  [VIEW.attention]: attentionView,
  [VIEW.aliases]: recordsView,
  [VIEW.temporal]: temporalView,
  [VIEW.lunar]: lunarView,
  [VIEW.periodicals]: periodicalsView,
  [VIEW.countries]: countriesView,
  [VIEW.newspapers]: newspapersView,
  [VIEW.sentiment]: sentimentView,
  [VIEW.collection]: collectionView,
  [VIEW.topics]: topicsView,
  [VIEW.field]: fieldView,
  [VIEW.cooccurrence]: cooccurrenceView,
  [VIEW.lexical]: lexicalView,
  [VIEW.places]: placesView,
  [VIEW.semanticMap]: semanticMapView,
  [VIEW.similar]: similarView,
};

/**
 * The one trust boundary between a host payload and a typed renderer. Only the
 * tag is checked: the tool that stamped it is bound by the same contract
 * (src/viewContract.ts types the server writers too), and every view already
 * reads optional fields defensively, so re-validating each shape here would
 * ship a second schema for no gain.
 */
function isTagged<K extends ViewName>(payload: BasePayload, name: K): payload is BasePayload & ChartPayload<K> {
  return payload.view === name;
}

function draw<K extends ViewName>(name: K, payload: BasePayload, options: ViewOptions): ViewResult | undefined {
  // Indexing the mapped registry with the same K the payload is narrowed to is
  // what lets TypeScript correlate renderer and payload without a cast.
  return isTagged(payload, name) ? VIEWS[name](payload, options) : undefined;
}

/** Render a payload with the view its tag names, or undefined for an unknown tag. */
export function renderView(payload: BasePayload, options: ViewOptions): ViewResult | undefined {
  const name = payload.view;
  // isViewName rejects inherited keys ("toString"), so a hostile tag cannot
  // reach Object.prototype through the registry lookup.
  return name !== undefined && isViewName(name) ? draw(name, payload, options) : undefined;
}
