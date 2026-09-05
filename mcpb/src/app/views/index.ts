import { VIEW, type ViewName } from "../../viewContract.js";
// The view registry: payload `view` tag → renderer.
//
// Adding a chart means adding a module here and setting the matching `view`
// tag on the tool's payload. The tags live in src/viewContract.ts (`VIEW`) so
// the server side cannot drift from this map silently, and test/unit.test.ts
// asserts the two sets agree; the registry also checks every tag at compile time.
import type { View } from "../shell.js";
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

export const VIEWS: Record<ViewName, View> = {
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
