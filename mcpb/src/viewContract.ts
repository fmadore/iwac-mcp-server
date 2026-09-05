// Dependency-free payload types and identifiers shared by server and browser.
//
// These are two separate bundles, `src/index.ts` (node) and `src/app/charts.ts`
// (browser, IIFE), and neither may import the other's tree: the app would drag
// in DuckDB, the server would drag in the DOM. This module has no imports at
// all, so both can depend on it without pulling anything behind it. Compare
// `UI_MIME_TYPE` in tools/appUi.ts, which is duplicated and kept honest by a
// test because the value it mirrors lives in a devDependency.

/**
 * `_meta` key on a tool RESULT under which chart-only data travels.
 *
 * MCP Apps hands the view the whole `CallToolResult` (the spec types the
 * tool-result notification's params as `CallToolResult`, `_meta` included),
 * while the model reads only `content` and `structuredContent`. That asymmetry
 * is a channel: data a chart needs but a model cannot use (per-point scatter
 * coordinates, a per-year-per-topic matrix) can ride here instead of being
 * billed to every conversation that triggers the chart.
 *
 * The name follows the spec's `<prefix>/<name>` form on a domain we control.
 * `modelcontextprotocol.io/` and `mcp.dev/` are reserved; `islam.zmo.de` is the
 * collection's own host.
 *
 * Rule for what may travel here: ONLY data that is redundant for reasoning.
 * Anything the model would need in order to answer the question the user
 * actually asked stays in `structuredContent`, in summarised form if the raw
 * series is too big. A host without MCP Apps shows the user no chart, so
 * whatever moves here is invisible to them: it must never be the answer.
 */
export const VIEW_DATA_META_KEY = "islam.zmo.de/viewData";

export const VIEW = {
  temporal: "temporal",
  // The lunar cycle is a different SHAPE, not just a different calendar: twelve
  // fixed named categories with a meaningful baseline, where `temporal` plots an
  // open-ended time series. Hijri year/month buckets stay on `temporal`.
  lunar: "lunar",
  periodicals: "periodicals",
  countries: "countries",
  newspapers: "newspapers",
  sentiment: "sentiment",
  collection: "collection",
  topics: "topics",
  field: "field",
  cooccurrence: "cooccurrence",
  lexical: "lexical",
  places: "places",
  semanticMap: "semanticMap",
  similar: "similar",
} as const;

export type ViewName = (typeof VIEW)[keyof typeof VIEW];

export function isViewName(value: string): value is ViewName {
  return Object.hasOwn(VIEW, value);
}

export interface ChartPayloadBase {
  view?: string;
  error?: string;
  note?: string;
}

/** Untrusted/partial host payload before selecting a renderer. */
export interface BasePayload extends ChartPayloadBase {
  [key: string]: unknown;
}

export interface Coverage {
  with_fulltext?: number;
  total?: number;
  percent?: number;
}

export interface CollectionPayload extends ChartPayloadBase {
  collection_name?: string;
  subset_counts?: Record<string, number>;
  failed_subsets?: string[];
  total_records?: number;
  fulltext_coverage?: Record<string, Coverage>;
  fulltext_note?: string;
  articles_by_country?: Record<string, number>;
  newspaper_count?: number;
  date_range?: { earliest?: string; latest?: string };
}

export interface Pair {
  a?: string;
  b?: string;
  count?: number;
}

export interface CooccurrencePayload extends ChartPayloadBase {
  subset?: string;
  field?: string;
  filters?: Record<string, unknown>;
  total_matches?: number;
  values?: { value?: string; count?: number }[];
  matrix?: number[][];
  top_pairs?: Pair[];
}

export interface Country {
  country?: string;
  article_count?: number;
  newspaper_count?: number;
  date_range?: { earliest?: string; latest?: string };
  polarity?: Record<string, number>;
}

export interface CountriesPayload extends ChartPayloadBase {
  total_countries?: number;
  /** Which model produced the polarity buckets — three scored the corpus. */
  polarity_model?: string;
  countries?: Country[];
}

export interface FieldValue {
  value?: string;
  count?: number;
}

export interface FieldPayload extends ChartPayloadBase {
  subset?: string;
  field?: string;
  filters?: Record<string, unknown>;
  total_matches?: number;
  items_with_value?: number;
  distinct_values?: number;
  values?: FieldValue[];
  other_values?: number;
  coverage_by_year?: Record<string, { total?: number; with_value?: number }>;
}

export interface LexicalGroup {
  group?: string;
  items?: number;
  readability_avg?: number;
  readability_median?: number;
  readability_n?: number;
  mattr_avg?: number;
  mattr_median?: number;
  words_avg?: number;
  words_median?: number;
}

export interface LexicalPayload extends ChartPayloadBase {
  group_by?: string;
  filters?: Record<string, unknown>;
  total_matches?: number;
  groups?: LexicalGroup[];
  metrics?: Record<string, { label?: string; higher_is?: string; range?: string }>;
  readability_excluded?: number;
}

export interface LunarPayload extends TemporalPayload {
  imprecise_date_count?: number;
  month_labels?: Record<string, string>;
}

export interface Newspaper {
  newspaper?: string;
  country?: string;
  article_count?: number;
  earliest_date?: string;
  latest_date?: string;
}

export interface NewspapersPayload extends ChartPayloadBase {
  country_filter?: string;
  total_newspapers?: number;
  total_articles?: number;
  newspapers?: Newspaper[];
}

export interface Periodical {
  newspaper?: string;
  country?: string;
  issue_count?: number;
  earliest_year?: number;
  latest_year?: number;
}

export interface PeriodicalsPayload extends ChartPayloadBase {
  country_filter?: string;
  total_periodicals?: number;
  periodicals?: Periodical[];
}

export interface Place {
  place?: string;
  count?: number;
  lat?: number;
  lng?: number;
}

export interface PlacesPayload extends ChartPayloadBase {
  subset?: string;
  filters?: Record<string, unknown>;
  total_matches?: number;
  items_with_place?: number;
  items_by_country?: Record<string, number>;
  places?: Place[];
  ungeocoded?: { place?: string; count?: number }[];
  ungeocoded_mentions?: number;
}

export interface SemanticPoint {
  id?: string;
  title?: string;
  group?: string;
  x?: number;
  y?: number;
}

export interface SemanticMapPayload extends ChartPayloadBase {
  groups?: Record<string, number>;
  subset?: string;
  filters?: Record<string, unknown>;
  total_matches?: number;
  projected?: number;
  color_by?: string;
  explained_variance?: number[];
  points?: SemanticPoint[];
}

export interface Subjectivity {
  scale?: string;
  /** Derived by ranking the labels 1-5, not a stored score — hence the name. */
  mean_rank?: number;
  median_rank?: number;
  rank_scale?: string;
  scored?: number;
  unscored?: number;
  distribution?: Record<string, number>;
  caveat?: string;
}

export interface MedianRank {
  scale?: string;
  scored?: number;
  mean?: number;
  median?: number;
  distribution?: Record<string, number>;
  note?: string;
  caveat?: string;
}

export interface ModelBlock {
  polarity_distribution?: Record<string, number>;
  centrality_distribution?: Record<string, number>;
  /** Consensus only: subjectivity arrives as a float median, never as labels. */
  subjectivity_median_rank?: MedianRank;
  disputed?: Record<string, number | string>;
  note?: string;
  /** Per-scale scored counts. The distributions drop their unscored key, so a
   * model that answered fewer articles is invisible without this. */
  coverage?: Record<string, number>;
  model_caveat?: string;
  subjectivity?: Subjectivity;
}

export interface SentimentPayload extends ChartPayloadBase, ModelBlock {
  model?: string;
  total_articles?: number;
  filters?: Record<string, unknown>;
  models?: string[];
  by_model?: Record<string, ModelBlock>;
  agreement?: {
    field?: string;
    scored_by_all?: number;
    unanimous?: number;
    unanimous_percent?: number;
    pairwise?: Record<string, number>;
    base?: string;
    base_caveats?: Record<string, string>;
  };
  agreement_matrix?: { rows?: string; cols?: string; counts?: Record<string, Record<string, number>> };
  consensus?: ModelBlock;
}

export interface Neighbour {
  id?: string;
  title?: string;
  score?: number;
  newspaper?: string;
  pub_date?: string;
  country?: string;
  url?: string;
}

export interface SimilarPayload extends ChartPayloadBase {
  subset?: string;
  source?: { id?: string; title?: string; url?: string };
  neighbours?: Neighbour[];
}

export interface TemporalPayload extends ChartPayloadBase {
  subset?: string;
  granularity?: string;
  calendar?: string;
  group_by?: string;
  filters?: Record<string, unknown>;
  total_matches?: number;
  dated_count?: number;
  undated_count?: number;
  imprecise_date_count?: number;
  distribution?: Record<string, number>;
  distribution_by_group?: Record<string, Record<string, number>>;
}

export interface Topic {
  topic_id?: number;
  label?: string;
  count?: number;
  avg_prob?: number;
}

export interface TopicsPayload extends ChartPayloadBase {
  span?: string[];
  trend_by_topic?: Record<string, { total: number; first: string; last: string; peak_year: string; peak_count: number; median_year: string }>;
  subset?: string;
  filters?: Record<string, unknown>;
  total_matches?: number;
  classified?: number;
  topics?: Topic[];
  periods?: string[];
  series_by_topic?: Record<string, Record<string, number>>;
}

/** Reconstructed chart payloads; dense fields may arrive through result _meta. */
export interface ChartPayloads {
  collection: CollectionPayload;
  cooccurrence: CooccurrencePayload;
  countries: CountriesPayload;
  field: FieldPayload;
  lexical: LexicalPayload;
  lunar: LunarPayload;
  newspapers: NewspapersPayload;
  periodicals: PeriodicalsPayload;
  places: PlacesPayload;
  semanticMap: SemanticMapPayload;
  sentiment: SentimentPayload;
  similar: SimilarPayload;
  temporal: TemporalPayload;
  topics: TopicsPayload;
}

/** Fields sent exclusively to the chart when a tool returns a model summary. */
export interface ChartOnlyData {
  topics: Pick<TopicsPayload, "periods" | "series_by_topic">;
  semanticMap: Pick<SemanticMapPayload, "points">;
}

export type ChartPayload<K extends ViewName> = ChartPayloads[K] & { view: K };
export type ChartModelPayload<K extends keyof ChartOnlyData> =
  Omit<ChartPayload<K>, keyof ChartOnlyData[K]> & { [P in keyof ChartOnlyData[K]]?: never };
