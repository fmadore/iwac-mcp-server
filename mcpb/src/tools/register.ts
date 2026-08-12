import { registerArticleTools } from "./articles.js";
import { registerSentimentTools } from "./sentiment.js";
import { registerIndexTools } from "./indexTools.js";
import { registerStatsTools } from "./stats.js";
import { registerPublicationTools } from "./publications.js";
import { registerReferenceTools } from "./references.js";
import { registerDocumentTools } from "./documents.js";
import { registerAudiovisualTools } from "./audiovisual.js";
import { registerImageTools } from "./images.js";
import { registerAggregateTools } from "./aggregates.js";
import { registerSearchTools } from "./search.js";
import { registerAppResources } from "./appUi.js";
import { registerSkillResources } from "./skills.js";
import type { Server } from "./_shared.js";

/** Register all IWAC tools on the server, grouped by domain. */
export function registerTools(server: Server): void {
  // The one ui:// resource every chart renders from. Registered before the
  // tools so the resource exists by the time a tool advertises it in `_meta`.
  registerAppResources(server);
  // The `skill://` tree plus the SEP-2640 `skills/*` methods over the same
  // catalogue: the research workflow, served alongside the tools it documents
  // so remote-HTTP callers need no separate download.
  registerSkillResources(server);
  // Unified search/fetch first: they satisfy the OpenAI Deep Research contract and
  // are the entry point for skill-less clients (see INSTRUCTIONS in index.ts).
  registerSearchTools(server);
  registerArticleTools(server);
  registerSentimentTools(server);
  registerIndexTools(server);
  registerStatsTools(server);
  registerAggregateTools(server);
  registerPublicationTools(server);
  registerReferenceTools(server);
  registerDocumentTools(server);
  registerAudiovisualTools(server);
  registerImageTools(server);
}
