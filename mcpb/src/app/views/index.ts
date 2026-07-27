// The view registry: payload `view` tag → renderer.
//
// Adding a chart means adding a module here and setting the matching `view`
// tag on the tool's payload. The tags live in src/tools/appUi.ts (`VIEW`) so
// the server side cannot drift from this map silently, and test/unit.test.ts
// asserts the two sets agree.
import type { View } from "../shell.js";
import { collectionView } from "./collection.js";
import { cooccurrenceView } from "./cooccurrence.js";
import { countriesView } from "./countries.js";
import { fieldView } from "./field.js";
import { lexicalView } from "./lexical.js";
import { newspapersView } from "./newspapers.js";
import { periodicalsView } from "./periodicals.js";
import { placesView } from "./places.js";
import { sentimentView } from "./sentiment.js";
import { temporalView } from "./temporal.js";
import { topicsView } from "./topics.js";

export const VIEWS: Record<string, View> = {
  temporal: temporalView,
  periodicals: periodicalsView,
  countries: countriesView,
  newspapers: newspapersView,
  sentiment: sentimentView,
  collection: collectionView,
  topics: topicsView,
  field: fieldView,
  cooccurrence: cooccurrenceView,
  lexical: lexicalView,
  places: placesView,
};
