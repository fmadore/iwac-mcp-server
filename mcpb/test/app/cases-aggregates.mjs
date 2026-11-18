// Render cases for the corpus aggregates: topics, bylines, co-occurrence,
// lexical metrics and the six-model sentiment panel. test/app.test.mjs renders
// every case through the real bundle, in the order the modules append them.

/** Appends this module's [name, payload, extra?] render cases, in file order. */
export function addAggregateCases(CASES) {
  CASES.push([
    "topics",
    {
      view: "topics",
      subset: "articles",
      filters: {},
      total_matches: 12287,
      classified: 12234,
      topics: [
        {
          topic_id: 12,
          label: "imam - mosquée - communauté_musulman - prière - fidèle - hadj",
          count: 1989,
          avg_prob: 0.347,
        },
        {
          topic_id: 7,
          label: "religieux - politique - etat - question - communauté - religion",
          count: 1251,
          avg_prob: 0.318,
        },
      ],
      periods: ["1999", "2000"],
      series_by_topic: {
        "imam - mosquée - communauté_musulman - prière - fidèle - hadj": { 1999: 10, 2000: 20 },
        "(other topics)": { 1999: 5, 2000: 8 },
      },
    },
    (markup) => {
      // Six-term LDA labels must be shortened for the cells but kept in full in
      // the tooltip, which is the only place the whole label survives.
      if (!markup.includes("imam · mosquée · communauté musulman…")) return "LDA label was not shortened for display";
      if (!markup.includes("communauté_musulman - prière - fidèle - hadj"))
        return "full label missing from the tooltip";
      if (!markup.includes("(other topics)")) return "the residual band did not render";
      return null;
    },
  ]);

  CASES.push([
    "field (bylines)",
    {
      view: "field",
      subset: "articles",
      field: "author",
      filters: {},
      total_matches: 12287,
      items_with_value: 9664,
      distinct_values: 2463,
      values: [
        { value: "Agence Togolaise de Presse", count: 272 },
        { value: "Diaby Salif", count: 181 },
      ],
      other_values: 2461,
      coverage_by_year: { 1970: { total: 48, with_value: 15 }, 1971: { total: 36, with_value: 7 } },
    },
    (markup) => {
      if (!markup.includes("Bylines")) return "field title not mapped";
      if (!markup.includes("Agence Togolaise de Presse")) return "missing a ranked value";
      if (!markup.includes("2 461 further values")) return "did not disclose the untruncated remainder";
      if (!markup.includes("31.3%")) return "coverage share panel did not render a percentage";
      return null;
    },
  ]);

  CASES.push([
    "cooccurrence",
    {
      view: "cooccurrence",
      subset: "articles",
      field: "subject",
      filters: {},
      total_matches: 12287,
      values: [
        { value: "Prière", count: 2139 },
        { value: "Hadj", count: 1917 },
        { value: "Paix", count: 1894 },
      ],
      matrix: [
        [2139, 354, 796],
        [354, 1917, 214],
        [796, 214, 1894],
      ],
      top_pairs: [
        { a: "Prière", b: "Paix", count: 796 },
        { a: "Prière", b: "Hadj", count: 354 },
      ],
    },
    (markup) => {
      if (!markup.includes("Prière × Paix: 796")) return "matrix cell tooltip missing";
      // The diagonal is blanked, so a 3x3 matrix draws 6 cells, not 9.
      const cells = (markup.match(/Prière × Prière/g) ?? []).length;
      if (cells !== 0) return "the diagonal should be blanked out of the heatmap";
      if (!markup.includes("Prière + Paix")) return "top-pairs chart missing";
      return null;
    },
  ]);

  CASES.push([
    "lexical",
    {
      view: "lexical",
      group_by: "country",
      filters: {},
      total_matches: 12287,
      groups: [
        {
          group: "Côte d'Ivoire",
          items: 3994,
          readability_avg: 65.23,
          readability_n: 3993,
          mattr_avg: 0.815,
          words_avg: 621,
        },
        {
          group: "Burkina Faso",
          items: 3659,
          readability_avg: 63.15,
          readability_n: 3659,
          mattr_avg: 0.811,
          words_avg: 758,
        },
      ],
      metrics: { mattr: { label: "Lexical richness (MATTR)" } },
      readability_excluded: 9,
    },
    (markup) => {
      if (!markup.includes("Readability")) return "readability panel missing";
      if (!markup.includes("0.815")) return "MATTR value not rendered at full precision";
      if (!markup.includes("9 non-French items are excluded")) return "did not disclose the readability exclusion";
      if (!markup.includes("already length-robust")) return "dropped the MATTR normalisation warning";
      return null;
    },
  ]);

  CASES.push([
    "sentiment (six models)",
    {
      view: "sentiment",
      model: "all",
      // Real generation-2 figures, measured over the 12,098 articles all six
      // models scored (2026-10-27 revision), so a rendering change that mangles
      // the numbers is visible as a wrong-looking chart rather than a plausible
      // one. Note what each new member did to the headline: unanimity on polarity
      // fell 43% → 36% with the fourth, 36% → 32% with the fifth and 32% → 30%
      // with the sixth. Coverage is uneven in BOTH directions, which is why the
      // blocks below carry `coverage`: qwen is measured on 200 fewer articles
      // than the usual 12,298 and haiku on 4,319 more.
      total_articles: 16715,
      filters: {},
      models: [
        "gpt-5-6-luna",
        "mistral-small-2603",
        "deepseek-v4-flash-0731",
        "gemma-4-31b-it",
        "qwen3-8-27b",
        "claude-haiku-5-5",
      ],
      by_model: {
        "gpt-5-6-luna": {
          polarity_distribution: {
            Positif: 6146,
            Neutre: 5017,
            "Très positif": 425,
            Négatif: 375,
            "Non applicable": 290,
            "Très négatif": 45,
          },
          subjectivity: {
            scale:
              "Très objectif | Plutôt objectif | Mixte | Plutôt subjectif | Très subjectif (ordinal, least to most subjective)",
            scored: 12008,
            unscored: 341,
            distribution: {
              "Très objectif": 1144,
              "Plutôt objectif": 7900,
              Mixte: 314,
              "Plutôt subjectif": 1914,
              "Très subjectif": 736,
            },
            mean_rank: 2.434,
            median_rank: 2,
            rank_scale: "1 = Très objectif … 5 = Très subjectif; derived here, not stored",
            caveat: "Weakest of the three scales: inter-model agreement κ 0.16-0.52.",
          },
          coverage: { polarity: 12298, centrality: 12298, subjectivity: 12008, matched_articles: 16715 },
        },
        "mistral-small-2603": {
          polarity_distribution: {
            Positif: 4985,
            Neutre: 4093,
            "Très positif": 2087,
            "Non applicable": 587,
            Négatif: 362,
            "Très négatif": 184,
          },
          coverage: { polarity: 12298, matched_articles: 16715 },
        },
        "deepseek-v4-flash-0731": {
          polarity_distribution: {
            Neutre: 6649,
            Positif: 4001,
            "Très positif": 900,
            "Non applicable": 484,
            Négatif: 223,
            "Très négatif": 41,
          },
          coverage: { polarity: 12298, matched_articles: 16715 },
        },
        "gemma-4-31b-it": {
          polarity_distribution: {
            Neutre: 7275,
            Positif: 3871,
            "Très positif": 627,
            "Non applicable": 243,
            Négatif: 233,
            "Très négatif": 49,
          },
          coverage: { polarity: 12298, matched_articles: 16715 },
        },
        // The short member. It also barely uses the extremes — 176 Très positif
        // against Luna's 425, and 5 Très négatif — so its ring is a real shape,
        // not a copy of its neighbour's.
        "qwen3-8-27b": {
          polarity_distribution: {
            Neutre: 6298,
            Positif: 5107,
            "Non applicable": 288,
            Négatif: 224,
            "Très positif": 176,
            "Très négatif": 5,
          },
          coverage: { polarity: 12098, matched_articles: 16715 },
          model_caveat: "Scores 12,098 articles where four other models score 12,298.",
        },
        // The wide member: its ring includes 4,366 articles no other model read.
        "claude-haiku-5-5": {
          polarity_distribution: {
            Neutre: 8239,
            Positif: 6511,
            "Non applicable": 906,
            Négatif: 520,
            "Très positif": 404,
            "Très négatif": 37,
          },
          coverage: { polarity: 16617, matched_articles: 16715 },
          model_caveat: "Scores 16,617 articles where the others score at most 12,298.",
        },
      },
      agreement: {
        field: "polarity",
        scored_by_all: 12098,
        unanimous: 3632,
        unanimous_percent: 30,
        pairwise: {
          "gpt-5-6-luna~mistral-small-2603": 7019,
          "gpt-5-6-luna~deepseek-v4-flash-0731": 8277,
          "gpt-5-6-luna~gemma-4-31b-it": 8470,
          "gpt-5-6-luna~qwen3-8-27b": 8874,
          "mistral-small-2603~deepseek-v4-flash-0731": 6605,
          "mistral-small-2603~gemma-4-31b-it": 6128,
          "mistral-small-2603~qwen3-8-27b": 6502,
          "deepseek-v4-flash-0731~gemma-4-31b-it": 9064,
          "deepseek-v4-flash-0731~qwen3-8-27b": 8607,
          "gemma-4-31b-it~qwen3-8-27b": 9056,
          "gpt-5-6-luna~claude-haiku-5-5": 9015,
          "mistral-small-2603~claude-haiku-5-5": 6975,
          "deepseek-v4-flash-0731~claude-haiku-5-5": 8496,
          "gemma-4-31b-it~claude-haiku-5-5": 8458,
          "qwen3-8-27b~claude-haiku-5-5": 9070,
        },
        base: "articles scored on polarity by all 6 models (of 16715 matched)",
        base_caveats: {
          "qwen3-8-27b": "Scores 12,098 articles where four other models score 12,298.",
          "claude-haiku-5-5": "Scores 16,617 articles where the others score at most 12,298.",
        },
      },
      // Measured alongside the rest. It decides 10,463 articles where the
      // agreement base holds 12,098 (scored by all six, of which 3,632 are
      // unanimous): the two count different things on different sets, which is
      // exactly what the chart has to keep apart. With six voters a 3-3 split
      // forms no majority, which is most of why the consensus fell from 11,869.
      consensus: {
        polarity_distribution: {
          Neutre: 5238,
          Positif: 4358,
          "Très positif": 337,
          "Non applicable": 322,
          Négatif: 186,
          "Très négatif": 22,
        },
        centrality_distribution: {
          "Très central": 7940,
          Marginal: 1114,
          Central: 988,
          Secondaire: 649,
          "Non abordé": 304,
        },
        coverage: { polarity: 10463, centrality: 10995, subjectivity: 12078, matched_articles: 16715 },
        disputed: { polarite: 1835, centralite: 1303, subjectivite: 4247, any: 6126 },
      },
      agreement_matrix: {
        rows: "gpt-5-6-luna",
        cols: "mistral-small-2603",
        counts: {
          Négatif: { Négatif: 128, Neutre: 137, "Très négatif": 65, Positif: 34 },
          Neutre: { Neutre: 2913, Positif: 1406, "Non applicable": 309 },
        },
      },
    },
    (markup) => {
      // Count-driven, so a sixth member changes the heading instead of making it
      // wrong — the title said "three models" over four rings until v3.2.0.
      if (!markup.includes("6 models compared")) return "did not switch to the comparison view";
      if (!markup.includes("30%")) return "agreement rate missing from the headline";
      if (!markup.includes("gpt-5-6-luna ↔ mistral-small-2603")) return "pairwise agreement chart missing";
      if (!markup.includes("deepseek-v4-flash-0731 ↔ gemma-4-31b-it")) return "the fourth model's pairs are missing";
      if (!markup.includes("gemma-4-31b-it ↔ qwen3-8-27b")) return "the fifth model's pairs are missing";
      if (!markup.includes("qwen3-8-27b ↔ claude-haiku-5-5")) return "the sixth model's pairs are missing";
      if (!markup.includes("all 6")) return "the unanimity bar should name the panel size";
      // The uneven coverage must reach the CHART, not only the JSON: a ring drawn
      // on 200 fewer, or 4,319 more, articles than the one beside it is a
      // misreading waiting to happen, and the four members on the usual base
      // must stay unannotated. Measured against the fullest ring, all five of
      // the others would have been captioned short.
      if (!markup.includes("200 fewer articles scored")) return "the short member's ring is not captioned";
      if (!/4\D?319 more articles scored/.test(markup)) return "the wide member's ring is not captioned";
      if ((markup.match(/(fewer|more) articles scored/g) ?? []).length !== 2)
        return "only the short and the wide member's rings should be captioned";
      if (!markup.includes("articles no other model read")) return "the coverage note should name the wide member";
      // The consensus must render, and must NOT read as a seventh annotator: it sits
      // in its own panel and the note says outright that no model produced it.
      if (!markup.includes("Panel consensus")) return "the panel's conclusion is missing from the comparison";
      if (!markup.includes("No model produced it")) return "the consensus must disclaim being a model";
      // Digit groups use THOUSANDS_SEP, which is a space rather than a comma, so
      // these match the separator loosely instead of hard-coding it.
      if (!/10\D?463/.test(markup)) return "the consensus should state its own base, not borrow the agreement one";
      if (!/subjectivite 4\D?247/.test(markup)) return "the split-panel breakdown is missing";
      // The agreeing diagonal is blanked so the ramp covers the disagreements.
      if (markup.includes("Négatif × Négatif")) return "the agreeing diagonal should be blanked";
      if (!markup.includes("Négatif × Neutre: 137")) return "confusion cell missing";
      return null;
    },
  ]);
}
