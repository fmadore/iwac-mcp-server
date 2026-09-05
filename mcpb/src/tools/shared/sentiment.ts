

// -----------------------------------------------------------------------------
// AI sentiment models
// -----------------------------------------------------------------------------

export interface SentimentModel {
  /** Canonical id — the exact model that produced the scores. */
  id: string;
  /** Dataset column prefix: `<prefix>_polarite`, `<prefix>_centralite_islam_musulmans`, … */
  prefix: string;
  /** Vendor shorthand also accepted on input. */
  aliases: string[];
  /**
   * Something a reader must know before comparing this model's counts with
   * another's — currently only a coverage shortfall. Lives here rather than at
   * the call sites so the registry stays the one place a model is described,
   * and travels into the payload beside that model's numbers.
   */
  caveat?: string;
}

/**
 * The five models of the generation-2 annotation campaign. All ran the same
 * prompt (fingerprint d14ace9ac192), which is what makes them comparable to each
 * other and not to generation 1.
 *
 * Coverage is NOT uniform, and that is the one thing to know before comparing
 * their counts. Four of them score all 12,298 French- and English-language
 * articles (the 51 Ewé/Kabiyè/Dendi/untagged ones are skipped deliberately: the
 * prompt is French, and a French-prompted model returns confident but unusable
 * output for them). qwen3-8-27b scores 12,098 — see its entry below.
 *
 * Generation 1 (`gemini-3-flash-preview`, `gpt-5-mini`, `ministral-14b-2512`) is
 * NOT served here. Its columns still exist on the Hub, but the archive's own
 * annotations were emptied on 2026-08-07 and the two generations differ in
 * model, prompt AND subjectivity dtype — so mixing them in one vocabulary would
 * put cross-model comparisons one typo away from confounding all three. Retired
 * handles get a named error instead; see RETIRED_SENTIMENT_MODELS.
 *
 * Only vendor shorthand is aliased. A retired EXACT model id is never remapped
 * onto its vendor's successor: `gpt-5-mini` and `gpt-5-6-luna` disagree, and
 * quietly answering with the wrong one is the ambiguity this registry exists to
 * prevent.
 */
export const SENTIMENT_MODELS: SentimentModel[] = [
  { id: "gpt-5-6-luna", prefix: "gpt_5_6_luna", aliases: ["chatgpt", "openai", "gpt", "luna"] },
  { id: "mistral-small-2603", prefix: "mistral_small_2603", aliases: ["mistral"] },
  { id: "deepseek-v4-flash-0731", prefix: "deepseek_v4_flash_0731", aliases: ["deepseek"] },
  // The Google-family member since 2026-08-14, routed through OpenRouter rather
  // than the Gemini API. `google` resolves here — a vendor shorthand naming the
  // vendor's generation-2 member, exactly as `mistral` and `chatgpt` do — while
  // `gemini` stays refused: Gemini is a different product line that scored this
  // corpus in generation 1 only, so re-pointing it here would be the silent
  // substitution this registry exists to prevent.
  { id: "gemma-4-31b-it", prefix: "gemma_4_31b_it", aliases: ["gemma", "google"] },
  // The fifth member (2026-08-25), and the only one annotated on hardware the
  // project controls (a self-hosted vLLM run) rather than a vendor API. `qwen`
  // names the model line this member actually belongs to, so it resolves —
  // unlike `gemini`, whose line never scored generation 2.
  {
    id: "qwen3-8-27b",
    prefix: "qwen3_8_27b",
    aliases: ["qwen", "alibaba"],
    // The 200-article shortfall is deliberate and final, not a run to repair:
    // each was attempted four times and then retired. It is also not missing at
    // random — the failures concentrate on articles the panel reads as
    // peripheral to Islam (6.2% of `Marginal` articles unscored against ~1% of
    // `Central` and `Très central` ones), because the model declines to place a
    // subjectivity label where Islam is marginal while the prompt licenses
    // declining only where Islam is absent.
    caveat:
      "Scores 12,098 articles where the other four score 12,298. The 200-article gap is deliberate (retired " +
      "after four attempts each), and concentrates on articles peripheral to Islam — 6.2% of `Marginal` " +
      "articles are unscored against ~1% of `Central` ones — so any base restricted to articles all models " +
      "scored leans slightly toward material where Islam is central.",
  },
];

/**
 * Handles that named a real annotator once and must not be silently re-pointed.
 * Generation 1's three ids, plus the product-line shorthands whose generation-2
 * namesake does not exist: `gemini` (the Gemini slot ran in generation 1 only —
 * Gemma 4 31B holds the Google slot now, but it is not Gemini) and `ministral`
 * (a distinct Mistral product line from Mistral Small).
 */
export const RETIRED_SENTIMENT_MODELS: Record<string, string> = {
  "gemini-3-flash-preview": "generation 1, dropped from this server",
  "gpt-5-mini": "generation 1, dropped from this server",
  "ministral-14b-2512": "generation 1, dropped from this server",
  gemini:
    "the Gemini slot scored the corpus in generation 1 only; generation 2's Google-family member is " +
    "gemma-4-31b-it, a different model line — ask for it by name (or use the shorthand 'google')",
  ministral: "Ministral 14B is generation 1; Mistral Small 2603 is a different model, ask for it by name",
};

/**
 * The model reported by the single-model surfaces: the `polarity`/`centrality`/
 * `subjectivity` columns on article rows, search_by_sentiment's filters, and
 * get_country_comparison. Those name it explicitly rather than implying a
 * consensus — get_sentiment_distribution with model:"all" is the tool for that.
 *
 * gpt-5-6-luna and not one of the other four, for three reasons that have held
 * through two panel additions:
 *
 *  - It is complete on all three fields — its only subjectivity gaps are exactly
 *    its `Non abordé` rows, a principled abstention rather than a dropped answer
 *    — where deepseek-v4-flash-0731 omits ~489 scores it owed.
 *  - It sits near the centre of the panel rather than at an edge: mean pairwise
 *    polarity agreement 65.7% against Mistral Small's 54.6%, and the Mistral
 *    family is a persistent outlier on centrality, which is a bad thing for a
 *    default to make invisible.
 *  - Moving the default is not a neutral act. Every inline `polarity` value this
 *    server has ever returned is Luna's, and re-pointing it would silently
 *    re-label all of them while nothing in the payload shape changed.
 *
 * ADDING a model must therefore leave this line alone. gemma-4-31b-it is equally
 * complete (its 294 unscored subjectivity rows are likewise exactly its
 * `Non abordé` ones) and "as good as the default" is not a reason to become it.
 * qwen3-8-27b agrees with Luna more closely than any other pair on polarity
 * (κ 0.54) and on subjectivity (κ 0.52), which makes it the most tempting
 * candidate yet and still not one: it is 200 articles short, so promoting it
 * would put a silent hole in every inline polarity this server returns.
 */
export const DEFAULT_SENTIMENT_MODEL: SentimentModel = SENTIMENT_MODELS[0];

/** Canonical ids, for `valid_values` in an error and for tool descriptions. */
export const SENTIMENT_MODEL_IDS: string[] = SENTIMENT_MODELS.map((m) => m.id);

/** The three scored columns (polarity, centrality, subjectivity) of one model. */
export function sentimentCols(m: SentimentModel): {
  polarity: string;
  centrality: string;
  subjectivity: string;
} {
  return {
    polarity: `${m.prefix}_polarite`,
    centrality: `${m.prefix}_centralite_islam_musulmans`,
    subjectivity: `${m.prefix}_subjectivite_score`,
  };
}

/** Normalise a model handle: case, whitespace and `_`/`-` are interchangeable. */
function sentimentKey(input: string): string {
  return input.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

/**
 * Resolve a caller's model handle to its registry entry, accepting the canonical
 * id, a vendor alias, or the raw column prefix (`_` and `-` are interchangeable,
 * so `gpt_5_6_luna` and `gpt-5-6-luna` both land on the same model).
 */
export function resolveSentimentModel(input: string): SentimentModel | undefined {
  const key = sentimentKey(input);
  return SENTIMENT_MODELS.find((m) => m.id === key || m.aliases.includes(key));
}

/** Why a retired handle is refused, or undefined if it was never one. */
export function retiredSentimentModel(input: string): string | undefined {
  return RETIRED_SENTIMENT_MODELS[sentimentKey(input)];
}

/**
 * The panel's own conclusion, precomputed upstream and merely served here.
 *
 * NOT a model, and deliberately not a member of SENTIMENT_MODELS: no annotator
 * produced these values, so nothing may echo them back in a `model` field that
 * elsewhere always names the exact model that judged. `resolveSentimentModel`
 * must keep refusing "consensus" for that reason.
 *
 * The majority threshold follows the votes ACTUALLY CAST (over half, minimum
 * two), which is the one thing that makes these worth serving next to this
 * server's own `agreement` block: agreement is measured on articles every model
 * scored, so a row one model abstained on drops out of it entirely, where the
 * consensus still decides that row on the votes it has.
 *
 * The three fields do not behave alike, and assuming they do is the trap:
 *
 *  - polarity and centrality are MAJORITY LABELS. Empty means one of two
 *    different things — no majority formed, or nobody voted — and only
 *    CONSENSUS_DISPUTE_COL tells them apart. Empty NEVER means "not computed".
 *  - subjectivity is a MEDIAN RANK on the 1-5 scale stored as a float. A median
 *    resolves whenever at least one model voted, so its coverage is HIGHER than
 *    the majority fields', and an even number of voters yields a half-rank
 *    (1.5, 2.5, …) that maps to no label at all. Never render it as a label,
 *    and never join it to SUBJECTIVITY_VALUES.
 */
export const CONSENSUS_COLS = {
  polarity: "consensus_polarite",
  centrality: "consensus_centralite",
  subjectivity: "consensus_subjectivite_score",
} as const;

/** Pipe-joined list of the fields the panel split on, empty where it did not. */
export const CONSENSUS_DISPUTE_COL = "sentiment_disagreement";

/**
 * The field names as they appear inside CONSENSUS_DISPUTE_COL. French, matching
 * the column vocabulary rather than this server's English parameter names, and a
 * dispute does not mean the same thing across them: on polarity and centrality
 * it is why the consensus is empty, on subjectivity the median still resolved.
 */
export const DISPUTE_FIELDS = ["polarite", "centralite", "subjectivite"] as const;

