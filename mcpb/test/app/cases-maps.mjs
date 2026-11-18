// Render cases for the maps and neighbours: places, the semantic map, similar
// items, and the empty temporal state. test/app.test.mjs renders every case
// through the real bundle, in the order the modules append them.

/** Appends this module's [name, payload, extra?] render cases, in file order. */
export function addMapCases(CASES) {
  CASES.push([
    "places",
    {
      view: "places",
      subset: "articles",
      filters: {},
      total_matches: 12287,
      items_with_place: 10634,
      items_by_country: { "Côte d'Ivoire": 3994, "Burkina Faso": 3659, Benin: 2003 },
      places: [
        // Country-level, geocoded to a centroid: must NOT become a bubble.
        { place: "Côte d'Ivoire", count: 2761, lat: 8, lng: -5.5 },
        { place: "Ouagadougou", count: 1624, lat: 12.36566, lng: -1.53388 },
        { place: "Lomé", count: 406, lat: 6.13, lng: 1.22 },
        // Outside the West African frame: counted and disclosed, never drawn.
        { place: "La Mecque", count: 1649, lat: 21.4225, lng: 39.826111 },
      ],
      ungeocoded: [{ place: "Riviera Golf", count: 153 }],
      ungeocoded_mentions: 1497,
    },
    (markup) => {
      if ((markup.match(/<circle/g) ?? []).length !== 2) return "expected exactly the two in-frame settlements";
      // Titles are escaped, so the apostrophe arrives as &#39;. Matching the raw
      // name, as this used to, could never fail.
      if (/<circle[^>]*><title>Côte d&#39;Ivoire:/.test(markup)) return "a country was drawn as a bubble";
      if (!markup.includes("Named at country level")) return "country-level panel missing";
      if (!markup.includes("La Mecque (off map)")) return "off-frame place not surfaced in the ranking";
      if (!markup.includes("Riviera Golf (not geocoded)")) return "ungeocoded place not surfaced";
      if (!markup.includes("1 geocoded place falls outside")) return "off-frame count not disclosed";
      if (!markup.includes("Natural Earth")) return "basemap provenance missing";
      return null;
    },
  ]);

  CASES.push([
    "semantic map (weak projection)",
    {
      view: "semanticMap",
      subset: "articles",
      filters: {},
      total_matches: 12287,
      projected: 300,
      color_by: "country",
      // 18% is the real figure for 768-d article embeddings; the view must say
      // so rather than let the reader take the distances at face value.
      explained_variance: [0.1349, 0.0466],
      points: Array.from({ length: 300 }, (_, i) => ({
        id: String(i),
        title: `Article ${i}`,
        group: ["Benin", "Togo", "Niger"][i % 3],
        x: Math.cos(i) * 0.3,
        y: Math.sin(i) * 0.2,
      })),
      note: "PCA over 768-dimension embeddings.",
    },
    (markup) => {
      if ((markup.match(/<circle/g) ?? []).length !== 300) return "not every point was drawn";
      if (!markup.includes("18.1%")) return "explained variance missing from the headline";
      if (!markup.includes("distances here are a weak signal")) return "a weak projection must be flagged as such";
      if (!markup.includes("This is PCA, not UMAP")) return "missing the UMAP disclaimer";
      return null;
    },
  ]);

  CASES.push([
    "similar items",
    {
      view: "similar",
      subset: "articles",
      source: { id: "10076", title: "Tabaski 2018 : 800 bœufs abattus", url: "https://islam.zmo.de/x" },
      neighbours: [
        {
          id: "2374",
          title: "Fête de la tabaski : 832 bœufs",
          score: 0.8747,
          newspaper: "Sidwaya",
          pub_date: "2018-08-23",
        },
        { id: "4018", title: "Tabaski 2018 : l'ONG FOSAPA solidaire", score: 0.8225, newspaper: "L'Observateur" },
        { id: "3428", title: "Tabaski 2017 : tolérance religieuse", score: 0.6979, newspaper: "Sidwaya" },
      ],
      note: "Cosine similarity over the stored embeddings; 1.0 is identical.",
    },
    (markup) => {
      if (!markup.includes("0.875")) return "scores should render at 3 decimals";
      if (!markup.includes("3 neighbours")) return "neighbour count missing";
      if (!markup.includes("not evidence of copying")) return "missing the interpretation caution";
      // The above-threshold bar is coloured differently so the cliff is visible.
      if (!markup.includes('data-key="2374"')) return "stable source ID missing";
      return null;
    },
  ]);

  CASES.push([
    "temporal (empty)",
    {
      view: "temporal",
      subset: "documents",
      granularity: "year",
      filters: { keyword: "zzzz" },
      total_matches: 0,
      dated_count: 0,
      undated_count: 0,
      distribution: {},
    },
    null, // no SVG expected; checked separately below
  ]);
}
