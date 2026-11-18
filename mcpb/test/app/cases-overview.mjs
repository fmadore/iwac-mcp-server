// Render cases for the overview charts: temporal, periodicals, countries,
// newspapers, sentiment and collection. test/app.test.mjs renders every case
// through the real bundle, in the order the modules append them.

/** Appends this module's [name, payload, extra?] render cases, in file order. */
export function addOverviewCases(CASES) {
  CASES.push([
    "temporal (flat)",
    {
      view: "temporal",
      subset: "articles",
      granularity: "year",
      filters: { keyword: "charia" },
      total_matches: 120,
      dated_count: 118,
      undated_count: 2,
      distribution: { 1998: 10, 1999: 40, 2000: 68 },
    },
    (markup) => {
      if (!markup.includes("1998")) return "missing an x-axis label";
      if (!markup.includes("keyword: charia")) return "missing the filter chip";
      if (!markup.includes("carry no usable date")) return "did not disclose the undated items";
      return null;
    },
  ]);

  CASES.push([
    "temporal (grouped)",
    {
      view: "temporal",
      subset: "articles",
      granularity: "month",
      group_by: "country",
      filters: {},
      total_matches: 6,
      dated_count: 6,
      undated_count: 0,
      distribution_by_group: { Benin: { "2001-01": 2, "2001-02": 1 }, Togo: { "2001-02": 3 } },
    },
    (markup) => {
      if (!markup.includes("legend")) return "grouped chart drew no legend";
      if (!markup.includes("Benin")) return "legend is missing a group";
      return null;
    },
  ]);

  CASES.push([
    "periodicals",
    {
      view: "periodicals",
      total_periodicals: 3,
      periodicals: [
        { newspaper: "Islam Info", country: "Burkina Faso", issue_count: 695, earliest_year: 2005, latest_year: 2020 },
        {
          newspaper: "An-Nasr Vendredi",
          country: "Burkina Faso",
          issue_count: 318,
          earliest_year: 1998,
          latest_year: 2012,
        },
        // No year range: must be disclosed, not silently dropped.
        { newspaper: "Sans dates", country: "Togo", issue_count: 4 },
      ],
    },
    (markup) => {
      if (!markup.includes("Islam Info")) return "missing a series label";
      if (!markup.includes("695")) return "issue count is not in the tooltip";
      if (!markup.includes("1 series carry no usable year")) return "undated series were not disclosed";
      return null;
    },
  ]);

  CASES.push([
    "countries",
    {
      view: "countries",
      total_countries: 2,
      polarity_model: "gpt-5-6-luna",
      countries: [
        {
          country: "Burkina Faso",
          article_count: 4000,
          newspaper_count: 12,
          date_range: { earliest: "1990-01-01", latest: "2020-12-31" },
          polarity: { Positif: 1000, Neutre: 2000, Négatif: 1000 },
        },
        { country: "Togo", article_count: 900, newspaper_count: 5 },
      ],
    },
    (markup) => {
      if (!markup.includes("Burkina Faso")) return "missing a country";
      if (!markup.includes("Polarity mix per country")) return "polarity panel did not render";
      // The chart must name the model that judged, not just "AI".
      if (!markup.includes("gpt-5-6-luna")) return "polarity chart did not name its model";
      if (!markup.includes("Polarity shown for 1 of 2")) return "did not disclose partial polarity coverage";
      return null;
    },
  ]);

  CASES.push([
    "newspapers",
    {
      view: "newspapers",
      total_newspapers: 30,
      total_articles: 1000,
      newspapers: Array.from({ length: 30 }, (_, i) => ({
        newspaper: `Journal ${i}`,
        country: "Benin",
        article_count: 100 - i,
      })),
    },
    (markup) => {
      if (!markup.includes("Journal 0")) return "missing the top title";
      if (markup.includes("Journal 29")) return "drew past the top-N cap";
      if (!markup.includes("Showing the top 25 of 30")) return "capped the list without saying so";
      return null;
    },
  ]);

  CASES.push([
    "sentiment",
    {
      view: "sentiment",
      model: "gpt-5-6-luna",
      total_articles: 120,
      filters: { country: "Niger" },
      polarity_distribution: { Neutre: 60, "Très négatif": 20, Positif: 20 },
      centrality_distribution: { Central: 50, Marginal: 50 },
      subjectivity: {
        scale:
          "Très objectif | Plutôt objectif | Mixte | Plutôt subjectif | Très subjectif (ordinal, least to most subjective)",
        scored: 100,
        unscored: 20,
        distribution: {
          "Très objectif": 40,
          "Plutôt objectif": 30,
          Mixte: 10,
          "Plutôt subjectif": 15,
          "Très subjectif": 5,
        },
        mean_rank: 2.15,
        median_rank: 2,
        rank_scale: "1 = Très objectif … 5 = Très subjectif; derived here, not stored",
        caveat: "Weakest of the three scales: inter-model agreement κ 0.16-0.52.",
      },
    },
    (markup) => {
      if ((markup.match(/<svg/g) ?? []).length < 3) return "expected a donut for each of the three vocabularies";
      // Ordinal order, not alphabetical: Positif must precede Neutre.
      if (markup.indexOf("Positif") > markup.indexOf("Neutre")) return "polarity slices are not in scale order";
      if (markup.indexOf("Très objectif") > markup.indexOf("Plutôt subjectif"))
        return "subjectivity slices are not in scale order";
      if (!markup.includes("20 matching articles carry no gpt-5-6-luna score"))
        return "did not reconcile scored vs matched";
      // The chart is the easiest thing here to quote out of context, so the
      // weakness of the scale has to travel with it.
      if (!markup.includes("κ 0.16-0.52")) return "subjectivity caveat missing from the chart";
      if (!markup.includes("mean rank 2.15")) return "derived rank not disclosed as derived";
      return null;
    },
  ]);

  CASES.push([
    "collection",
    {
      view: "collection",
      collection_name: "Islam West Africa Collection (IWAC)",
      subset_counts: { articles: 12287, publications: 1501, index: 4854, images: 30 },
      total_records: 18672,
      fulltext_coverage: { articles: { with_fulltext: 7480, total: 12287, percent: 61 } },
      fulltext_note: "This is the PUBLIC dataset: full text (OCR) ships only for public items.",
      newspaper_count: 118,
    },
    (markup) => {
      if (!markup.includes("articles")) return "missing a treemap cell";
      if (!markup.includes("61%")) return "full-text gauge did not render the share";
      if (!markup.includes("PUBLIC dataset")) return "dropped the full-text caveat";
      return null;
    },
  ]);
}
