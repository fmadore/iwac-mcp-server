// The model/view payload split: a chart must render identically whether its
// series arrives in the model-visible halves or in `_meta`. Called in order by
// test/app.test.mjs on the shared app instance.

export async function viewSplitChecks({ fail, renderPayload, checkMarkup }) {
  // --- model/view payload split --------------------------------------------------
  // Chart-heavy tools send the model a summary and the chart the full series, the
  // series travelling in `_meta` (src/viewContract.ts). The charts must come out
  // pixel-identical either way. If a view silently degrades when its data arrives
  // through `_meta`, the split has cost the user the thing it was protecting.
  {
    const points = Array.from({ length: 300 }, (_, i) => ({
      id: String(i),
      title: `Article ${i}`,
      group: ["Benin", "Togo", "Niger"][i % 3],
      x: Math.cos(i) * 0.3,
      y: Math.sin(i) * 0.2,
    }));
    const modelHalf = {
      view: "semanticMap",
      subset: "articles",
      filters: {},
      total_matches: 12287,
      projected: 300,
      color_by: "country",
      groups: { Benin: 100, Togo: 100, Niger: 100 },
      explained_variance: [0.1349, 0.0466],
      note: "PCA over 768-dimension embeddings.",
    };

    const split = await renderPayload(modelHalf, { points });
    checkMarkup("semantic map (split)", split);
    if ((split.match(/<circle/g) ?? []).length !== 300) {
      fail("semantic map (split): points arriving via _meta were not all drawn");
    }

    // Same data, old shape: the merge must be additive, not a replacement.
    const inline = await renderPayload({ ...modelHalf, points });
    if (split !== inline) fail("semantic map: the _meta split rendered differently from the inline payload");

    // Without the _meta half there is no series at all, proof the chart really is
    // reading `_meta` here and not quietly falling back to something else.
    const starved = await renderPayload(modelHalf);
    if ((starved.match(/<circle/g) ?? []).length !== 0) {
      fail("semantic map: drew points with no series in either half");
    }

    // Same for the topics band chart, whose split is partial: `topics` stays with
    // the model, only the per-year matrix moves.
    const topicsModel = {
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
      ],
      span: ["1999", "2000"],
      trend_by_topic: {
        "imam - mosquée - communauté_musulman - prière - fidèle - hadj": {
          total: 30,
          first: "1999",
          last: "2000",
          peak_year: "2000",
          peak_count: 20,
          median_year: "2000",
        },
      },
    };
    const topicsView = {
      periods: ["1999", "2000"],
      series_by_topic: {
        "imam - mosquée - communauté_musulman - prière - fidèle - hadj": { 1999: 10, 2000: 20 },
        "(other topics)": { 1999: 5, 2000: 8 },
      },
    };
    const topicsSplit = await renderPayload(topicsModel, topicsView);
    checkMarkup("topics (split)", topicsSplit);
    if (!topicsSplit.includes("(other topics)")) fail("topics (split): the residual band did not render from _meta");
  }
}
