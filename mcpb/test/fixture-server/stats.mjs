// Fixture-server checks for the statistics tools and the temporal distribution,
// including the Hijri calendar and the lunar filters on the search tools.
// Called in order by test/fixture-server.test.mjs.

/** Runs on the shared legacy-era client, in file order. */
export async function statsChecks({ call }) {
  // --- stats + temporal (structured) ----------------------------------------------
  await call("get_collection_stats", {}, {
    structured: true,
    check: (p) => {
      const expected = { articles: 6, publications: 3, references: 4, documents: 2, audiovisual: 3, images: 3, index: 7 };
      for (const [k, v] of Object.entries(expected)) {
        if (p.subset_counts?.[k] !== v) return `subset_counts.${k} = ${p.subset_counts?.[k]}, expected ${v}`;
      }
      if (p.failed_subsets) return `unexpected failed_subsets: ${p.failed_subsets}`;
      if (p.date_range?.earliest !== "1987-03-02") return `date_range.earliest ${p.date_range?.earliest}`;
      // The public dataset masks full text per row; a keyword count is a floor,
      // not a census, and the stats tool is where that gets stated.
      const cov = p.fulltext_coverage?.articles;
      if (!cov) return "fulltext_coverage missing for articles";
      if (cov.with_fulltext !== 5 || cov.total !== 6) return `articles coverage ${JSON.stringify(cov)}, expected 5/6`;
      if (!String(p.fulltext_note ?? "").includes("public")) return "fulltext_note missing";
      if (p.fulltext_coverage.index) return "index has no OCR column and must not claim coverage";
      return null;
    },
  });
  await call("get_newspaper_stats", { country: "Niger" }, {
    structured: true,
    check: (p) => (p.total_articles === 1 ? null : `Niger fixture count ${p.total_articles}, expected 1 (Nigeria conflation?)`),
  });
  // Every fixture newspaper has one article, so the order is decided entirely
  // by the tie-break. Without one, DuckDB's parallel aggregation returned
  // these rows in a different order from run to run, and the same question
  // got a differently ordered answer each time it was asked.
  await call("get_newspaper_stats", {}, {
    structured: true,
    check: (p) => {
      const rows = p.newspapers ?? [];
      for (let i = 1; i < rows.length; i++) {
        const [a, b] = [rows[i - 1], rows[i]];
        const inOrder =
          a.article_count > b.article_count ||
          (a.article_count === b.article_count && String(a.newspaper) <= String(b.newspaper));
        if (!inOrder) return `newspapers not ordered by count, then name: ${a.newspaper} before ${b.newspaper}`;
      }
      return rows.length > 1 ? null : "expected several fixture newspapers";
    },
  });
  await call("get_country_comparison", {}, {
    structured: true,
    check: (p) => {
      if (p.total_countries !== 5) return `expected 5 article countries, got ${p.total_countries}`;
      // The polarity buckets are one model's, so the payload has to say whose.
      if (p.polarity_model !== "claude-haiku-5-5") return `polarity_model wrong: ${p.polarity_model}`;
      if (!p.countries?.some((c) => c.polarity && Object.keys(c.polarity).length)) return "no country carries polarity";
      return null;
    },
  });
  await call("get_sentiment_distribution", { country: "Benin" }, {
    structured: true,
    check: (p) => {
      if (p.total_articles !== 2) return `Benin total ${p.total_articles}, expected 2`;
      if (p.polarity_distribution?.Négatif !== 1) return "polarity_distribution missing Négatif=1";
      return null;
    },
  });
  await call("search_by_sentiment", { polarity: "tres positif" }, {
    check: (p) => (p.total_matches === 1 ? null : `unaccented polarity should match 1, got ${p.total_matches}`),
  });
  // Subjectivity became filterable when generation 2 turned it from a 1-5 float
  // into a closed label vocabulary. Same accent-folding contract as the other two.
  await call("search_by_sentiment", { subjectivity: "plutot objectif" }, {
    check: (p) =>
      p.total_matches === 3 ? null : `unaccented subjectivity should match 3, got ${p.total_matches}`,
  });
  // Narrower than either filter alone (3 ∩ 3 = 2), so a dropped clause shows up
  // as a count that is too high rather than as a plausible-looking zero.
  await call("search_by_sentiment", { subjectivity: "Plutôt objectif", polarity: "Neutre" }, {
    check: (p) =>
      p.total_matches === 2 ? null : `subjectivity AND polarity should match 2, got ${p.total_matches}`,
  });
  await call("search_by_sentiment", { subjectivity: "3" }, {
    expectError: true,
    checkBody: (b) =>
      b.includes("valid_values") && b.includes("Très objectif")
        ? null
        : "a generation-1 numeric rating should error with the label vocabulary, not silently match nothing",
  });
  await call("list_periodicals", {}, {
    structured: true,
    check: (p) => (p.total_periodicals === 3 ? null : `expected 3 periodicals, got ${p.total_periodicals}`),
  });

  // get_temporal_distribution — the new tool, thoroughly.
  await call("get_temporal_distribution", {}, {
    structured: true,
    check: (p) => {
      if (p.subset !== "articles" || p.granularity !== "year") return "defaults should be articles/year";
      if (p.total_matches !== 6 || p.dated_count !== 6 || p.undated_count !== 0)
        return `counts wrong: ${JSON.stringify({ t: p.total_matches, d: p.dated_count, u: p.undated_count })}`;
      if (p.distribution?.["1995"] !== 1 || p.distribution?.["2019"] !== 1) return `distribution wrong: ${JSON.stringify(p.distribution)}`;
      const years = Object.keys(p.distribution);
      if (String(years) !== String([...years].sort())) return "years not sorted ascending";
      return null;
    },
  });
  await call("get_temporal_distribution", { keyword: "pèlerinage" }, {
    check: (p) => (p.dated_count === 2 && p.distribution?.["1987"] === 1 ? null : `keyword-filtered distribution wrong: ${JSON.stringify(p.distribution)}`),
  });
  await call("get_temporal_distribution", { group_by: "country" }, {
    check: (p) => {
      if (!p.distribution_by_group?.Benin) return "grouped distribution missing Benin";
      if (p.distribution_by_group.Benin["1995"] !== 1) return "Benin 1995 count wrong";
      if (p.distribution) return "flat distribution should be absent when grouped";
      return null;
    },
  });
  await call("get_temporal_distribution", { subset: "publications", granularity: "month" }, {
    check: (p) => {
      if (p.distribution?.["1912"] !== undefined) return "bare years must not be plotted as month buckets";
      if (p.imprecise_date_count !== 2 || p.dated_count !== 1) return "year-only records must be disclosed as imprecise";
      if (p.distribution?.["1995-06"] !== 1) return "full date should bucket to 1995-06";
      return null;
    },
  });
  await call("get_temporal_distribution", { subset: "references", group_by: "country" }, {
    check: (p) =>
      p.distribution_by_group?.["Niger|Nigeria"] && String(p.note ?? "").includes("multi-valued")
        ? null
        : "pipe-joined group should surface with an explanatory note",
  });
  await call("get_temporal_distribution", { subset: "nonsense" }, {
    expectError: true,
    checkBody: (b) => (b.includes("valid_values") ? null : "invalid subset should list valid_values"),
  });
  await call("get_temporal_distribution", { subset: "references", group_by: "newspaper" }, {
    expectError: true,
    checkBody: (b) => (b.includes("not available") ? null : "newspaper group on references should error"),
  });
  // A supplied metadata filter whose column the subset lacks must error, not
  // silently return the WHOLE subset while echoing the filter as applied.
  await call("get_temporal_distribution", { subset: "references", newspaper: "Le Monde" }, {
    expectError: true,
    checkBody: (b) => (b.includes("not available") ? null : "inapplicable newspaper filter on references should error"),
  });

  // --- the Hijri calendar ----------------------------------------------------------
  // The lunar columns are precomputed by the pipeline
  // (post-processing/calculate_hijri_dates.py); the fixtures carry the same
  // hijridate values the pipeline would write. The six fixture articles fall in
  // Muharram, Jumada II, Rajab, Ramadan and Dhu al-Qa'da (×2).
  await call("get_temporal_distribution", { granularity: "lunar_month" }, {
    structured: true,
    check: (p) => {
      // lunar_month implies the Hijri calendar; the caller should not have to say so twice.
      if (p.calendar !== "hijri") return `lunar_month should imply calendar=hijri, got ${p.calendar}`;
      if (p.view !== "lunar") return `lunar_month should tag the lunar view, got ${p.view}`;
      const d = p.distribution ?? {};
      if (d["11"] !== 2) return `Dhu al-Qa'da should hold 2 articles, got ${JSON.stringify(d)}`;
      if (d["09"] !== 1 || d["01"] !== 1 || d["06"] !== 1 || d["07"] !== 1)
        return `lunar distribution wrong: ${JSON.stringify(d)}`;
      if (Object.keys(d).length !== 5) return `expected 5 occupied months, got ${JSON.stringify(d)}`;
      // Keys are zero-padded so they sort; names ride along so the model and the
      // chart never hard-code a transliteration.
      if (p.month_labels?.["09"] !== "Ramadan") return `month_labels wrong: ${JSON.stringify(p.month_labels)}`;
      // The two key sets are a CONTRACT, not a coincidence: the chart looks each
      // bucket up in month_labels, so a bucket key that misses is not an error
      // anywhere — it is a bar that silently never draws. Assert the label set is
      // exactly the twelve canonical keys, and that every bucket is one of them.
      // (Shipped once as '3.' — DOUBLE columns cast straight to VARCHAR — which
      // dropped nine of twelve months from the lunar chart without failing a
      // single test.)
      const canonical = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));
      const labelKeys = Object.keys(p.month_labels ?? {}).sort();
      if (labelKeys.length !== 12 || labelKeys.some((k, i) => k !== canonical[i]))
        return `month_labels keys must be exactly 01..12, got ${JSON.stringify(labelKeys)}`;
      const strays = Object.keys(d).filter((k) => !(k in (p.month_labels ?? {})));
      if (strays.length) return `lunar buckets absent from month_labels (they would not render): ${JSON.stringify(strays)}`;
      if (!String(p.note ?? "").includes("pooled across all Hijri years"))
        return "lunar_month must disclose that it pools years and is not seasonality";
      return null;
    },
  });
  await call("get_temporal_distribution", { calendar: "hijri", granularity: "year" }, {
    structured: true,
    check: (p) => {
      if (p.view !== "temporal") return "hijri YEARS are still a time series, so still the temporal view";
      if (p.distribution?.["1440"] !== 1 || p.distribution?.["1407"] !== 1)
        return `hijri year distribution wrong: ${JSON.stringify(p.distribution)}`;
      return null;
    },
  });
  await call("get_temporal_distribution", { calendar: "hijri", granularity: "month" }, {
    check: (p) =>
      p.distribution?.["1440-09"] === 1 ? null : `hijri year-month bucket wrong: ${JSON.stringify(p.distribution)}`,
  });
  // An imprecise date has no lunar month. It must be reported as excluded, never
  // folded into undated_count (which means "no date at all") and never plotted.
  await call("get_temporal_distribution", { subset: "publications", granularity: "lunar_month" }, {
    structured: true,
    check: (p) => {
      if (p.total_matches !== 3) return `publications total wrong: ${p.total_matches}`;
      if (p.dated_count !== 1) return `only the fully-dated issue converts, got ${p.dated_count}`;
      if (p.imprecise_date_count !== 2)
        return `the two year-only issues should be imprecise_date_count, got ${p.imprecise_date_count}`;
      if (p.undated_count !== 0) return `no issue is truly undated, got ${p.undated_count}`;
      if (!String(p.note ?? "").includes("too imprecise")) return "the imprecise exclusion must be disclosed";
      return null;
    },
  });
  // references deliberately has no lunar columns (an academic imprint date has no
  // meaningful lunar reading), so asking must be a self-correctable error.
  await call("get_temporal_distribution", { subset: "references", calendar: "hijri" }, {
    expectError: true,
    checkBody: (b) =>
      b.includes("no Hijri date columns") && b.includes("not references")
        ? null
        : "hijri on references should error and name the subsets that do carry lunar dates",
  });
  await call("get_temporal_distribution", { granularity: "lunar_month", calendar: "gregorian" }, {
    expectError: true,
    checkBody: (b) => (b.includes("Hijri bucket") ? null : "lunar_month + calendar=gregorian is incoherent and must error"),
  });
  await call("get_temporal_distribution", { calendar: "julian" }, {
    expectError: true,
    checkBody: (b) => (b.includes("valid_values") ? null : "invalid calendar should list valid_values"),
  });

  // The lunar filters on the search tools — what turns a peak into readable items.
  await call("search_articles", { hijri_month: "Ramadan" }, {
    check: (p) => {
      if (p.total_matches !== 1)
        return `hijri_month=Ramadan should find 1 article, got ${p.total_matches}`;
      const row = p.results?.[0];
      if (row?.date !== "2019-05-20") return `expected the 2019 Niger article, got ${row?.date}`;
      // Filtering by a calendar has to show that calendar, or the caller cannot
      // see what matched.
      if (row?.hijri_date !== "1440-09-15") return `row should carry its lunar date, got ${row?.hijri_date}`;
      return null;
    },
  });
  await call("search_articles", { hijri_month: "9" }, {
    check: (p) => (p.total_matches === 1 ? null : `the month number should behave like its name, got ${p.total_matches}`),
  });
  await call("search_articles", { hijri_month: "Dhou al-hijja" }, {
    check: (p) => (p.total_matches === 0 ? null : `no fixture article falls in Dhu al-Hijja, got ${p.total_matches}`),
  });
  await call("search_articles", { hijri_month: "11" }, {
    check: (p) => (p.total_matches === 2 ? null : `Dhu al-Qa'da should hold 2 articles, got ${p.total_matches}`),
  });
  await call("search_articles", { hijri_year: 1440 }, {
    check: (p) => (p.total_matches === 1 ? null : `hijri_year=1440 should find 1 article, got ${p.total_matches}`),
  });
  await call("search_articles", { hijri_month: "Ramadam" }, {
    expectError: true,
    checkBody: (b) =>
      b.includes("valid_values") && b.includes("Ramadan")
        ? null
        : "a misspelt lunar month must error with valid_values, not return an empty result",
  });
  await call("search_publications", { hijri_month: "Mouharram" }, {
    check: (p) => {
      if (p.total_matches !== 1) return `French month name on publications, got ${p.total_matches}`;
      // The articles fixture stores Hijri as BIGINT (the canonical int64) and
      // publications as the legacy DOUBLE, so this is the read that proves the
      // older revisions still render: unguarded, DOUBLE comes out '1416.0-1.-3.'.
      const date = p.results?.[0]?.hijri_date;
      return date === "1416-01-03" ? null : `a DOUBLE-typed lunar date should render as 1416-01-03, got ${date}`;
    },
  });
}
