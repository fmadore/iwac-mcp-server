// Register aggregate tools in their established public order.
import type { Server } from "./shared/results.js";
import { registerTopicsTools } from "./aggregates/topics.js";
import { registerDistributionsTools } from "./aggregates/distributions.js";
import { registerPlacesTools } from "./aggregates/places.js";
import { registerSemanticTools } from "./aggregates/semantic.js";
import { registerLexicalTools } from "./aggregates/lexical.js";

export function registerAggregateTools(server: Server): void {
  registerTopicsTools(server);
  registerDistributionsTools(server);
  registerPlacesTools(server);
  registerSemanticTools(server);
  registerLexicalTools(server);
}
