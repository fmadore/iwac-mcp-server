import { registerArticleTools } from "./articles.js";
import { registerSentimentTools } from "./sentiment.js";
import { registerIndexTools } from "./indexTools.js";
import { registerStatsTools } from "./stats.js";
import { registerPublicationTools } from "./publications.js";
import { registerReferenceTools } from "./references.js";
import { registerDocumentTools } from "./documents.js";
import { registerAudiovisualTools } from "./audiovisual.js";
import { registerSearchTools } from "./search.js";
import type { Server } from "./_shared.js";

/** Register all IWAC tools on the server, grouped by domain. */
export function registerTools(server: Server): void {
  // Unified search/fetch first: they satisfy the OpenAI Deep Research contract and
  // are the entry point for skill-less clients (see INSTRUCTIONS in index.ts).
  registerSearchTools(server);
  registerArticleTools(server);
  registerSentimentTools(server);
  registerIndexTools(server);
  registerStatsTools(server);
  registerPublicationTools(server);
  registerReferenceTools(server);
  registerDocumentTools(server);
  registerAudiovisualTools(server);
}
