// Deployment profiles: smaller tool surfaces for hosts that pay for every tool
// definition on every turn. The full surface sits within a few hundred tokens
// of its 16,000-token ceiling (test/token-budget.test.mjs), so a deployment
// that needs only part of it can stop paying for the rest.
//
// `full` (the default) registers everything. The others drop tools at
// registration (tools/register.ts), so a call to a dropped tool fails like any
// unknown tool, and the instructions name only tools that exist. Profiles cut
// discovery cost; they are not an access control. The semantic_search_* tools
// a profile lists still need IWAC_SEMANTIC_SEARCH_ENABLED.
//
// Pure: no config import, so tests can enumerate every profile.

const SEARCH = ["search", "fetch", "get_collection_stats"];

const READING = [
  "search_articles", "get_article", "semantic_search_articles",
  "search_index", "get_index_entry", "list_subjects", "list_locations", "list_persons",
  "search_publications", "list_periodicals", "get_publication_fulltext", "semantic_search_publications",
  "search_references", "get_reference", "semantic_search_references",
  "search_documents", "get_document",
  "search_audiovisual", "get_audiovisual", "list_audiovisual",
  "search_images", "get_image", "semantic_search_images",
];

const ANALYSIS = [
  "explore_corpus", "get_newspaper_stats", "get_country_comparison", "get_temporal_distribution",
  "get_topic_distribution", "get_field_distribution", "get_cooccurrence", "get_place_distribution",
  "get_semantic_map", "get_similar_items", "get_lexical_metrics",
  "search_by_sentiment", "get_sentiment_distribution",
  "list_subjects", "list_locations", "list_persons",
];

export const TOOL_PROFILES = {
  /** Every tool. */
  full: null,
  /** Finding and reading sources in every subset, with the temporal overview. */
  core: [...SEARCH, ...READING, "get_temporal_distribution"],
  /** Statistics, aggregates, sentiment and the research workbench over selections. */
  analysis: [...SEARCH, ...ANALYSIS],
  /** The cross-subset entry pair (ChatGPT deep research, API `allowed_tools`). */
  search: SEARCH,
} as const satisfies Record<string, readonly string[] | null>;

export type ToolProfile = keyof typeof TOOL_PROFILES;

/** The profile an IWAC_TOOL_PROFILE value names; an unknown name refuses to
 * start, because a typo would otherwise serve the wrong surface silently. */
export function resolveToolProfile(value: string | undefined): ToolProfile {
  const profile = value?.trim().toLowerCase() || "full";
  if (!Object.hasOwn(TOOL_PROFILES, profile))
    throw new Error(`IWAC_TOOL_PROFILE must be one of ${Object.keys(TOOL_PROFILES).join(", ")}; got '${value}'.`);
  return profile as ToolProfile;
}

/** Tool names a profile keeps, or null for every tool. */
export function allowedTools(profile: ToolProfile): ReadonlySet<string> | null {
  const names: readonly string[] | null = TOOL_PROFILES[profile];
  return names ? new Set(names) : null;
}
