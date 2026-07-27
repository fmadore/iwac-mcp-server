// The view registry: payload `view` tag → renderer.
//
// Adding a chart means adding a module here and setting the matching `view`
// tag on the tool's payload (src/tools/appUi.ts holds the tag constants, so
// server and app cannot drift apart silently).
import type { View } from "../shell.js";
import { temporalView } from "./temporal.js";

export const VIEWS: Record<string, View> = {
  temporal: temporalView,
};
