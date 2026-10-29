// What this server may claim about full-text coverage depends on WHICH mirror
// it reads. The public dataset masks OCR per item (about half the articles
// carry it); the private full mirror ships it for nearly everything. The
// sentences that tell a model how far a keyword count reaches are phrased here
// once, so the handshake, the prompts and the tool notes cannot disagree, and a
// private-mode server never repeats the public dataset's warning.
//
// No counts appear here on purpose: fixed figures went stale within weeks of
// being written. get_collection_stats computes the live ones on demand.
import { config } from "./config.js";

const PRIVATE = config.privateDataset;

/** The handshake's full-text sentences for each mirror. Both are exported so
 * the instructions length test can measure every mode without restarting. */
export const FULLTEXT_INSTRUCTIONS_PRIVATE =
  "This server reads the PRIVATE full mirror, so OCR ships for restricted items too. New arrivals can lack " +
  "enrichment. Keyword counts approach a census, though OCR errors hide some matches.";
export const FULLTEXT_INSTRUCTIONS_PUBLIC =
  "The public dataset omits restricted OCR; metadata and available AI summaries remain searchable. New " +
  "arrivals can lack enrichment. Keyword counts are a floor.";

/** The full-text sentences of the handshake's INTERPRETATION paragraph. */
export const FULLTEXT_INSTRUCTIONS = PRIVATE ? FULLTEXT_INSTRUCTIONS_PRIVATE : FULLTEXT_INSTRUCTIONS_PUBLIC;

/** The coverage clause of the research prompts' disclosure rule. */
export const FULLTEXT_PROMPT_RULE = PRIVATE
  ? "this server reads the private full mirror, where nearly every article carries OCR, but OCR errors still " +
    "hide matches, so check `fulltext_coverage` in get_collection_stats before calling a keyword count exhaustive."
  : "this public dataset carries OCR full text only for the items whose content is public (about half of the " +
    "articles), so check `fulltext_coverage` in get_collection_stats and present keyword counts as a floor, " +
    "not a census.";
