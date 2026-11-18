// Fixture-server checks for the corpus aggregates: topics, fields,
// co-occurrence, the semantic map, similar items (id shapes and the published
// neighbour list), date-bound and subset-filter refusals, and lexical metrics.
// Called in order by test/fixture-server.test.mjs.

/** Runs on the shared legacy-era client, in file order. */
export async function aggregateChecks({ call, fail }) {
  // --- corpus aggregates -----------------------------------------------------------
  await call("get_topic_distribution", {}, {
    structured: true,
    check: (p) => {
      if (p.total_matches !== 6 || p.classified !== 6) return `topic counts wrong: ${p.total_matches}/${p.classified}`;
      const top = p.topics?.[0];
      if (top?.count !== 2) return `expected a 2-article leading topic, got ${JSON.stringify(top)}`;
      if (!p.topics.every((t) => t.label && typeof t.avg_prob === "number")) return "topic rows missing label/avg_prob";
      // Descending by count is what every consumer assumes.
      const counts = p.topics.map((t) => t.count);
      if (String(counts) !== String([...counts].sort((a, b) => b - a))) return "topics not ordered by count";
      return null;
    },
  });
  // over_time splits its answer: the model gets each band's SHAPE, the chart gets
  // the per-year matrix through `_meta` (src/viewContract.ts). Both halves are
  // checked here, because a split that dropped the series on the floor would otherwise
  // look like a pass, since the model half alone still parses.
  await call("get_topic_distribution", { over_time: true, top_n: 1 }, {
    check: (p, _body, res) => {
      if (p.periods || p.series_by_topic) return "the raw per-year series must not be in the model's half";
      if (!p.span?.length) return "over_time returned no span";
      const trend = p.trend_by_topic ?? {};
      if (!Object.keys(trend).length) return "over_time returned no per-topic trend summary";
      for (const [label, t] of Object.entries(trend)) {
        if (!t.peak_year || !t.first || !t.last) return `trend for '${label}' is missing first/last/peak`;
        if (t.first > t.peak_year || t.peak_year > t.last) return `trend for '${label}' has peak outside [first,last]`;
        if (t.median_year < t.first || t.median_year > t.last) return `trend for '${label}' has median outside its span`;
      }

      const view = res._meta?.["islam.zmo.de/viewData"];
      if (!view) return "no view data in _meta, so the chart would have nothing to plot";
      if (!view.periods?.length) return "view half carries no periods";
      const bands = Object.keys(view.series_by_topic ?? {});
      if (!bands.includes("(other topics)")) return `top_n=1 should fold the rest into one band, got ${bands}`;
      // The bands must still total the classified count, or the area chart lies.
      const summed = bands.reduce((a, b) => a + Object.values(view.series_by_topic[b]).reduce((x, y) => x + y, 0), 0);
      if (summed !== p.classified) return `bands sum to ${summed}, classified is ${p.classified}`;
      // The summary must describe the series it replaced, not drift from it.
      for (const [label, t] of Object.entries(trend)) {
        const byYear = view.series_by_topic[label];
        if (!byYear) return `trend summarises '${label}', absent from the series`;
        const realTotal = Object.values(byYear).reduce((a, b) => a + b, 0);
        if (t.total !== realTotal) return `trend total for '${label}' is ${t.total}, series sums to ${realTotal}`;
        if (byYear[t.peak_year] !== t.peak_count) return `trend peak for '${label}' does not match the series`;
      }
      return null;
    },
  });
  // min_prob must exclude, and say what it excluded.
  await call("get_topic_distribution", { min_prob: 0.5 }, {
    check: (p) =>
      p.classified < 6 && String(p.note ?? "").includes("min_prob")
        ? null
        : `min_prob should shrink the set and disclose it: ${p.classified} / ${p.note}`,
  });

  await call("get_field_distribution", { field: "subject" }, {
    structured: true,
    check: (p) => {
      if (p.items_with_value !== 6) return `expected 6 subject-tagged articles, got ${p.items_with_value}`;
      // Pipe-split: 'Pèlerinage|Religion' must count once for each half.
      const ramadan = p.values?.find((v) => v.value === "Ramadan");
      if (ramadan?.count !== 2) return `Ramadan should appear twice, got ${JSON.stringify(ramadan)}`;
      if (!String(p.note ?? "").includes("multi-valued")) return "multi-valued fields must disclose double counting";
      return null;
    },
  });
  await call("get_field_distribution", { field: "author", over_time: true }, {
    check: (p) => {
      if (p.items_with_value !== 4) return `4 of 6 fixture articles are signed, got ${p.items_with_value}`;
      if (!p.coverage_by_year?.["1995"]) return "over_time returned no per-year coverage";
      const y = p.coverage_by_year["1995"];
      if (y.total !== 1 || y.with_value !== 1) return `1995 coverage wrong: ${JSON.stringify(y)}`;
      return null;
    },
  });
  await call("get_field_distribution", { field: "OCR" }, {
    expectError: true,
    checkBody: (b) => (b.includes("valid_values") ? null : "a non-rankable field should list the valid ones"),
  });
  await call("get_field_distribution", { field: "spatial", top_n: 1 }, {
    check: (p) =>
      p.values?.length === 1 && p.other_values > 0
        ? null
        : `top_n must cap AND report the remainder: ${JSON.stringify(p.values)} / ${p.other_values}`,
  });

  await call("get_cooccurrence", { field: "subject", top_n: 3 }, {
    structured: true,
    check: (p) => {
      if (p.values?.length !== 3) return `expected 3 axis values, got ${p.values?.length}`;
      const m = p.matrix;
      if (m.length !== 3 || m.some((r) => r.length !== 3)) return "matrix is not square";
      // Symmetric, with each value's own count on the diagonal.
      for (let i = 0; i < 3; i++) {
        if (m[i][i] !== p.values[i].count) return `diagonal ${i} should be the value's own count`;
        for (let j = 0; j < 3; j++) if (m[i][j] !== m[j][i]) return `matrix not symmetric at ${i},${j}`;
      }
      if (p.top_pairs?.some((x) => x.a === x.b)) return "top_pairs should not contain self-pairs";
      return null;
    },
  });

  // The point cloud is chart-only data: a 2-D PCA coordinate is an artefact of
  // this projection, not a fact the model can reason from, so it travels in
  // `_meta` and the model gets per-group counts instead.
  await call("get_semantic_map", { color_by: "country" }, {
    structured: true,
    check: (p, _body, res) => {
      if (p.projected !== 6) return `expected all 6 fixture articles projected, got ${p.projected}`;
      if (p.points) return "coordinates must not be in the model's half";
      const points = res._meta?.["islam.zmo.de/viewData"]?.points;
      if (!points?.length) return "no points in _meta, so the chart would render an empty scatter";
      if (points.length !== p.projected) return `_meta has ${points.length} points, projected says ${p.projected}`;
      if (!points.every((x) => Number.isFinite(x.x) && Number.isFinite(x.y))) return "a point has no finite coordinates";
      if (!points.every((x) => x.group)) return "color_by=country did not populate group";
      // The group counts the model is given must describe the cloud it replaced.
      const tally = {};
      for (const x of points) tally[x.group] = (tally[x.group] ?? 0) + 1;
      if (JSON.stringify(p.groups) !== JSON.stringify(tally)) {
        return `groups ${JSON.stringify(p.groups)} does not match the plotted points ${JSON.stringify(tally)}`;
      }
      const [a, b] = p.explained_variance ?? [];
      if (!(a > 0 && b >= 0 && a + b <= 1.0001)) return `explained_variance ${p.explained_variance} is not a share`;
      if (a < b) return "components should be ordered by variance";
      // The fixture embeddings are two separable clusters, so a 2-d projection
      // should capture nearly all of the variance.
      if (a + b < 0.9) return `two clusters in 4-d should project cleanly, got ${a + b}`;
      if (!String(p.note ?? "").includes("NOT the UMAP")) return "must disclaim the UMAP comparison";
      return null;
    },
  });
  // `polarity` is the stable public name for a column whose real name carries the
  // model; the default model's dataset spelling resolves onto it too.
  for (const value of ["polarity", "claude_haiku_5_5_polarite"]) {
    await call("get_semantic_map", { color_by: value }, {
      structured: true,
      check: (p, _body, res) => {
        if (p.color_by !== "polarity") return `color_by=${value} should echo "polarity", got ${p.color_by}`;
        const points = res._meta?.["islam.zmo.de/viewData"]?.points;
        if (!points?.every((x) => x.group)) return `color_by=${value} did not populate group`;
        return null;
      },
    });
  }
  // Another model's column must NOT alias onto `polarity`: it holds a
  // different model's reading, so colouring by it while the legend says
  // claude-haiku-5-5 would be a chart that lies. Luna's is the sharpest case,
  // since it was the default (and so accepted here) before v6.0.0.
  for (const value of ["gemini_3_flash_preview_polarite", "gpt_5_6_luna_polarite"]) {
    await call("get_semantic_map", { color_by: value }, {
      expectError: true,
      checkBody: (b) => (b.includes("valid_values") ? null : `${value} should be refused with valid_values`),
    });
  }
  // Deterministic: the same filter must project the same picture, or the chart
  // reshuffles itself on every call and cannot be read as evidence.
  {
    const one = await call("get_semantic_map", {}, {});
    const two = await call("get_semantic_map", {}, {});
    if (JSON.stringify(one?.points) !== JSON.stringify(two?.points))
      fail("get_semantic_map is not deterministic across calls");
  }
  await call("get_semantic_map", { color_by: "OCR" }, {
    expectError: true,
    checkBody: (b) => (b.includes("valid_values") ? null : "an invalid color_by should list the valid ones"),
  });

  await call("get_similar_items", { id: "101", limit: 3 }, {
    structured: true,
    check: (p) => {
      if (p.source?.id !== "101") return "source not echoed";
      if (p.neighbours?.length !== 3) return `expected 3 neighbours, got ${p.neighbours?.length}`;
      if (p.neighbours.some((n) => n.id === "101")) return "the source must not be its own neighbour";
      // Descending, and 105 (the other pilgrimage vector) must lead.
      const scores = p.neighbours.map((n) => n.score);
      if (String(scores) !== String([...scores].sort((a, b) => b - a))) return "neighbours not sorted by score";
      if (p.neighbours[0].id !== "105") return `nearest to 101 should be 105, got ${p.neighbours[0].id}`;
      if (!p.neighbours.every((n) => n.url?.startsWith("https://"))) return "neighbours need a resolvable url";
      return null;
    },
  });
  await call("get_similar_items", { id: "101", min_score: 0.999 }, {
    check: (p) => (p.neighbours?.length === 0 ? null : "min_score should be able to exclude everything"),
  });
  await call("get_similar_items", { id: "does-not-exist" }, {
    expectError: true,
    checkBody: (b) => (b.includes("No articles item") ? null : `unknown id should say so: ${b.slice(0, 120)}`),
  });

  // --- id shapes: `search`/`fetch` speak `<subset>:<o:id>`, so this must too ----
  await call("get_similar_items", { id: "articles:101", limit: 3 }, {
    structured: true,
    check: (p) => {
      if (p.source?.id !== "101") return "a namespaced id should resolve to the bare o:id";
      if (p.neighbours?.[0]?.id !== "105") return "namespaced id must give the same neighbours as the bare one";
      return null;
    },
  });
  await call("get_similar_items", { id: "articles:101", subset: "articles" }, {
    structured: true,
    check: (p) => (p.source?.id === "101" ? null : "an id whose prefix AGREES with subset is not a conflict"),
  });
  await call("get_similar_items", { id: "references:301", subset: "articles" }, {
    expectError: true,
    checkBody: (b) =>
      b.includes("names subset") ? null : `a prefix contradicting subset should say so: ${b.slice(0, 140)}`,
  });
  await call("get_similar_items", { id: "index:900" }, {
    expectError: true,
    checkBody: (b) => (b.includes("valid_values") ? null : `an unsupported id prefix should list valid subsets: ${b.slice(0, 140)}`),
  });

  // --- references are embedded by abstract, documents by full text ------------
  // Since dataset revision d834ab71 a reference's vector is `embedding_abstract`
  // (`embedding_OCR` is gone from references) and documents carry one at all.
  // References publish no neighbour list, so they rank live.
  await call("get_similar_items", { id: "references:301", limit: 3 }, {
    structured: true,
    check: (p) => {
      if (p.neighbours?.[0]?.id !== "304") return `nearest to reference 301 should be 304, got ${p.neighbours?.[0]?.id}`;
      if (p.neighbours_source !== "live" || p.stored_count !== 0)
        return `a subset without related_articles should rank live, got ${p.neighbours_source}/${p.stored_count}`;
      return p.note?.includes("publishes no neighbour list") ? null : "the note should say why the ranking is live";
    },
  });
  // A document's published list names documents; its stored score (0.5, where
  // the live cosine is ~0.25) proves that list was read.
  await call("get_similar_items", { id: "documents:501" }, {
    structured: true,
    check: (p) => {
      if (p.subset !== "documents" || p.neighbours?.[0]?.id !== "502") return "documents need similar items";
      if (p.neighbours[0].score !== 0.5 || p.neighbours_source !== "related_articles")
        return `documents should read their own stored list, got ${p.neighbours[0].score} from ${p.neighbours_source}`;
      return null;
    },
  });

  // --- the published neighbour list (related_articles, issue #49) -------------
  // Article 102's stored list contradicts its vectors (RELATED_OVERRIDES in
  // scripts/make-fixtures.mjs), so only reading the column gives this order.
  await call("get_similar_items", { id: "102", limit: 3 }, {
    structured: true,
    check: (p) => {
      const got = p.neighbours?.map((n) => `${n.id}:${n.score}`).join("|");
      if (got !== "104:0.1|106:0.09|103:0.08") return `stored list not read in stored order: ${got}`;
      if (p.neighbours_source !== "related_articles" || p.stored_count !== 3)
        return `expected related_articles/3, got ${p.neighbours_source}/${p.stored_count}`;
      return null;
    },
  });
  // Past its end the live ranking continues the list: the stored part is not
  // re-sorted, no id repeats, and the seam is reported.
  await call("get_similar_items", { id: "102", limit: 5 }, {
    structured: true,
    check: (p) => {
      const ids = p.neighbours?.map((n) => n.id) ?? [];
      if (ids.join() !== "104,106,103,105,101") return `expected the stored three then live, got ${ids.join()}`;
      if (new Set(ids).size !== ids.length) return "an id repeats across the seam";
      if (p.neighbours_source !== "related_articles+live" || p.stored_count !== 3)
        return `seam not reported: ${p.neighbours_source}/${p.stored_count}`;
      if (!(p.neighbours[3].score > p.neighbours[2].score))
        return "here the first live score should exceed the last stored one, and stay after it";
      return p.note?.includes("first 3") ? null : "the note should say where the seam falls";
    },
  });
  // min_score filters the combined list, and the seam moves with it.
  await call("get_similar_items", { id: "102", limit: 5, min_score: 0.085 }, {
    structured: true,
    check: (p) => {
      const ids = p.neighbours?.map((n) => n.id).join();
      return ids === "104,106,105,101" && p.stored_count === 2
        ? null
        : `min_score should filter stored and live alike: ${ids} (stored_count ${p.stored_count})`;
    },
  });
  // An empty cell means "not computed yet": the live query answers.
  await call("get_similar_items", { id: "103", limit: 3 }, {
    structured: true,
    check: (p) => {
      if (p.neighbours_source !== "live" || p.stored_count !== 0)
        return `an empty cell should fall back live, got ${p.neighbours_source}/${p.stored_count}`;
      if (p.neighbours?.[0]?.id !== "102") return `live nearest to 103 is 102, got ${p.neighbours?.[0]?.id}`;
      return p.note?.includes("no published neighbour list") ? null : "the note should say the list is missing";
    },
  });
  // A listed id the snapshot lacks (999) is dropped, and the note says so.
  await call("get_similar_items", { id: "104", limit: 3 }, {
    structured: true,
    check: (p) => {
      const ids = p.neighbours?.map((n) => n.id).join();
      if (ids !== "106,103,102") return `a missing id should be dropped, got ${ids}`;
      if (p.neighbours_source !== "related_articles") return `neighbours_source ${p.neighbours_source}`;
      return p.note?.includes("1 listed neighbour is absent") ? null : "the note should report the skipped id";
    },
  });
  await call("get_semantic_map", { subset: "references" }, {
    structured: true,
    check: (p) => (p.projected === 4 ? null : `all 4 fixture references carry a vector, projected ${p.projected}`),
  });

  // --- bad date bounds are rejected, never silently dropped --------------------
  // The regression this guards: an unparseable bound used to be discarded, so the
  // query widened to the WHOLE corpus while `filters` still echoed the bad value.
  const fullCorpus = (await call("get_field_distribution", { field: "subject" }, { structured: true }))?.total_matches;
  for (const [tool, args] of [
    ["get_field_distribution", { field: "subject", date_from: "not-a-date" }],
    ["get_field_distribution", { field: "subject", date_to: "yesterday" }],
    ["get_field_distribution", { field: "subject", date_from: "2001-13-01" }],
    ["get_topic_distribution", { date_from: "n/a" }],
    ["get_cooccurrence", { date_from: "n/a" }],
    ["get_place_distribution", { date_from: "n/a" }],
    ["get_semantic_map", { date_from: "n/a" }],
    ["get_lexical_metrics", { date_from: "n/a" }],
    // the same helper backs every date-filtering tool, not just the aggregates
    ["search_articles", { date_from: "not-a-date" }],
    ["search_references", { date_to: "circa 1990" }],
    ["search_publications", { date_from: "?" }],
    ["get_temporal_distribution", { date_from: "not-a-date" }],
  ]) {
    await call(tool, args, {
      expectError: true,
      checkBody: (b) =>
        b.includes("valid_format") ? null : `${tool} should reject a bad date bound, not drop it: ${b.slice(0, 160)}`,
    });
  }
  // ...while every documented shape still parses
  for (const args of [{ date_from: "2001" }, { date_from: "2001-06" }, { date_from: "2001-06-15" }, { date_from: "2001-06-15T09:30:00Z" }]) {
    await call("get_field_distribution", { field: "subject", ...args }, {
      structured: true,
      check: (p) => (p.total_matches <= fullCorpus ? null : `${JSON.stringify(args)} should still parse and filter`),
    });
  }

  // --- a filter the subset cannot honour is an error, not a no-op -------------
  // `references` has no `newspaper` column: this used to return the whole subset.
  await call("get_field_distribution", { field: "subject", subset: "references", newspaper: "Sidwaya" }, {
    expectError: true,
    checkBody: (b) =>
      b.includes("not available on subset") ? null : `an unhonourable filter should error: ${b.slice(0, 160)}`,
  });
  await call("get_field_distribution", { field: "newspaper", subset: "references" }, {
    expectError: true,
    checkBody: (b) => (b.includes("not available") ? null : "ranking a missing column should still error"),
  });

  await call("get_lexical_metrics", {}, {
    structured: true,
    check: (p) => {
      if (p.group_by !== "year") return "default grouping should be year";
      if (!p.groups?.length) return "no lexical groups";
      const g = p.groups.find((x) => x.group === "1995");
      if (!g) return "1995 group missing";
      if (g.readability_avg !== 41.5) return `1995 readability should be 41.5, got ${g.readability_avg}`;
      if (g.mattr_avg !== 0.62) return `1995 MATTR should be 0.62, got ${g.mattr_avg}`;
      if (!p.metrics?.mattr) return "metrics descriptor missing";
      return null;
    },
  });
  await call("get_lexical_metrics", { group_by: "country" }, {
    check: (p) => (p.groups?.some((g) => g.group === "Benin") ? null : "country grouping missing Benin"),
  });
}
