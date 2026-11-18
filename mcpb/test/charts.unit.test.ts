// Unit tests for the MCP App chart kernel, the place map, the co-mention
// network and the PCA projection. Split from the former test/unit.test.ts
// (November 2026); `npm run test:unit` runs it (tsx --test).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  bubbleMap,
  columns,
  donut,
  forceGraph,
  gantt,
  heatmapMatrix,
  horizontalBar,
  scatter,
  squarify,
  ticks,
  treemap,
} from "../src/app/svg.js";
import { BASEMAP, BASEMAP_BOUNDS } from "../src/app/basemap.js";
import { project2d } from "../src/pca.js";
import { csv, csvCell } from "../src/app/shell.js";
import { fmtInt, THOUSANDS_SEP } from "../src/app/theme.js";
import { carryFilters, temporalView } from "../src/app/views/temporal.js";
import { VIEWS } from "../src/app/views/index.js";
import { VIEW } from "../src/tools/appUi.js";
import { at } from "./_must.js";

// -----------------------------------------------------------------------------
// MCP App chart kernel (src/app/*) — pure string/geometry helpers, so they test
// in Node with no DOM. test/app.test.mjs covers the DOM-and-transport half by
// booting the real bundle.
// -----------------------------------------------------------------------------

describe("chart kernel", () => {
  it("ticks round the axis up to a 1/2/5 step", () => {
    assert.deepEqual(ticks(97), { max: 100, values: [0, 25, 50, 75, 100] });
    assert.deepEqual(ticks(3), { max: 3, values: [0, 1, 2, 3] });
    // A degenerate peak must still produce a drawable axis rather than NaNs.
    assert.deepEqual(ticks(0), { max: 1, values: [0, 1] });
    assert.equal(ticks(12287).max >= 12287, true);
  });

  it("squarify covers the rect exactly and keeps input order", () => {
    const rect = { x: 0, y: 0, w: 400, h: 200 };
    const values = [50, 30, 12, 5, 3];
    const boxes = squarify(values, rect);
    assert.equal(boxes.length, values.length);
    const area = boxes.reduce((a, b) => a + b.w * b.h, 0);
    assert.ok(Math.abs(area - rect.w * rect.h) < 1, `area ${area} != ${rect.w * rect.h}`);
    // Bigger value => bigger cell, and every cell stays inside the rect.
    assert.ok(at(boxes, 0).w * at(boxes, 0).h > at(boxes, 4).w * at(boxes, 4).h);
    for (const b of boxes) {
      assert.ok(b.x >= -0.01 && b.y >= -0.01, "cell starts outside the rect");
      assert.ok(b.x + b.w <= rect.w + 0.01 && b.y + b.h <= rect.h + 0.01, "cell overflows the rect");
    }
  });

  it("squarify degrades safely on empty or zero input", () => {
    assert.deepEqual(squarify([], { x: 0, y: 0, w: 10, h: 10 }), []);
    const zero = squarify([0, 0], { x: 0, y: 0, w: 10, h: 10 });
    assert.equal(zero.length, 2);
    assert.ok(zero.every((b) => b.w === 0 && b.h === 0));
  });

  it("charts escape data into markup", () => {
    // A newspaper title with an ampersand or quote must not break out of the
    // attribute it lands in; nothing here is ever set as HTML by the host.
    const svg = horizontalBar({
      items: [{ label: '"Le <b>Soir</b>" & co', value: 3 }],
      ariaLabel: "test",
      clickable: true,
    });
    assert.ok(!svg.includes("<b>"), "unescaped markup leaked into the chart");
    assert.ok(svg.includes("&#38;"), "ampersand was not escaped");
    // The whole attribute, escaped, so a quote in the data cannot close it early.
    // (The check this replaces ran on text already split past `data-key=`, so
    // it could never fail.)
    assert.ok(svg.includes('data-key="&#34;Le &#60;b&#62;Soir&#60;/b&#62;&#34; &#38; co"'), "data-key was not escaped");
  });

  // The views' listeners select `.hit[data-key]`, so a clickable mark without the
  // class is dead, and charts.ts still makes it keyboard-focusable as a button.
  // Four primitives used to emit data-key alone.
  it("every clickable primitive marks its keys with class hit, once", () => {
    const drawn: Record<string, string> = {
      columns: columns({ categories: ["a", "b"], series: [{ label: "s", values: [1, 2] }], clickable: true }),
      horizontalBar: horizontalBar({ items: [{ label: "a", value: 1 }], clickable: true }),
      gantt: gantt({ rows: [{ label: "a", start: 1990, end: 2000 }], clickable: true }),
      treemap: treemap({ items: [{ label: "a", value: 1 }], clickable: true }),
      heatmapMatrix: heatmapMatrix({ rows: ["a"], cols: ["b"], values: [[1]], clickable: true }),
      bubbleMap: bubbleMap({
        countries: BASEMAP,
        bounds: BASEMAP_BOUNDS,
        points: [{ label: "Ouagadougou", lat: 12.37, lng: -1.53, value: 3 }],
        choropleth: { Benin: 2 },
        clickable: true,
      }),
      forceGraph: forceGraph({ nodes: [{ label: "a", weight: 1 }, { label: "b", weight: 2 }], edges: [], clickable: true }),
      scatter: scatter({ points: [{ x: 0, y: 0, label: "a" }, { x: 1, y: 1, label: "b" }], clickable: true }),
    };
    for (const [name, svg] of Object.entries(drawn)) {
      const keys = svg.match(/data-key="/g)?.length ?? 0;
      const hits = svg.match(/class="(?:[\w-]+ )?hit" data-key="/g)?.length ?? 0;
      assert.ok(keys > 0, `${name} drew no clickable mark`);
      assert.equal(hits, keys, `${name}: ${keys - hits} clickable marks lack class="hit"`);
      assert.ok(!/<\w+[^>]*\sclass="[^"]*"[^>]*\sclass="/.test(svg), `${name} emitted two class attributes on one mark`);
    }
  });

  it("scatter draws points outside the named groups in grey, not the largest group's colour", () => {
    const svg = scatter({
      points: [{ x: 0, y: 0, label: "a", group: "big" }, { x: 1, y: 1, label: "b" }],
      groups: ["big"],
    });
    const fills = [...svg.matchAll(/<circle[^>]*fill="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(fills.length, 2);
    assert.equal(fills[1], "var(--muted)");
  });

  it("donut renders one arc per non-zero slice and totals the centre", () => {
    const svg = donut({ slices: [{ label: "positive", value: 3 }, { label: "neutral", value: 0 }, { label: "negative", value: 1 }] });
    assert.equal((svg.match(/<path/g) ?? []).length, 2);
    assert.ok(svg.includes(">4<"), "centre value should default to the total");
    assert.ok(svg.includes("75%"), "slice tooltip should carry the share");
  });

  it("donut and treemap return nothing rather than an empty frame", () => {
    assert.equal(donut({ slices: [] }), "");
    assert.equal(treemap({ items: [] }), "");
    assert.equal(columns({ categories: [], series: [] }), "");
    assert.equal(gantt({ rows: [] }), "");
    assert.equal(heatmapMatrix({ rows: [], cols: [], values: [] }), "");
  });

  it("gantt places a single-year run inside the plot", () => {
    const svg = gantt({ rows: [{ label: "Islam Info", start: 2000, end: 2000, weight: 695 }] });
    assert.ok(svg.includes("Islam Info"));
    assert.ok(svg.includes("695 issues"));
    assert.ok(!svg.includes("NaN"), "degenerate span produced NaN geometry");
  });

  it("heatmap leaves non-finite cells empty instead of drawing rgb(NaN)", () => {
    const svg = heatmapMatrix({ rows: ["a", "b"], cols: ["a", "b"], values: [[Number.NaN, 2], [2, Number.NaN]] });
    assert.equal((svg.match(/<rect/g) ?? []).length, 2);
    assert.ok(!svg.includes("NaN"));
  });

  it("csv quotes delimiters and defuses formula injection", () => {
    assert.equal(csv([["year", "count"], [1999, 3]]), "year,count\r\n1999,3");
    assert.equal(csvCell('Le "Soir", Cotonou'), '"Le ""Soir"", Cotonou"');
    assert.equal(csvCell("=1+1"), "'=1+1");
    assert.equal(csvCell(null), "");
  });

  it("fmtInt groups thousands without depending on the iframe locale", () => {
    assert.equal(fmtInt(12287), `12${THOUSANDS_SEP}287`);
    assert.equal(THOUSANDS_SEP, " ", "the separator should be a narrow no-break space");
    assert.equal(fmtInt(7), "7");
    assert.equal(fmtInt(-1200), `-1${THOUSANDS_SEP}200`);
  });

  it("the temporal view carries filters forward and discloses undated items", () => {
    const result = temporalView({
      view: "temporal",
      subset: "articles",
      granularity: "year",
      filters: { country: "Togo", keyword: null },
      total_matches: 10,
      dated_count: 8,
      undated_count: 2,
      distribution: { 1999: 3, 2000: 5 },
    });
    assert.match(result.title, /articles per year/);
    assert.ok(result.body.includes("<svg"));
    assert.ok(result.notes?.some((n) => typeof n === "string" && n.includes("no usable date")));
    // Null filters must not travel back to the server as explicit nulls.
    assert.deepEqual(carryFilters({ filters: { country: "Togo", keyword: null, subject: "" } }), { country: "Togo" });
  });

  it("the server's view tags and the app's view registry agree", () => {
    // The two halves ship in different bundles and cannot import each other at
    // runtime, so a tool stamping a tag no view renders — or a view nothing
    // ever reaches — would only show up as a blank panel in Claude.
    for (const [tag, view] of Object.entries(VIEWS)) {
      assert.equal(typeof view, "function", `view ${tag} is not a function`);
    }
    assert.deepEqual(Object.keys(VIEWS).sort(), Object.values(VIEW).sort());
  });
});

// -----------------------------------------------------------------------------
// The place map's geometry. A projection bug is invisible in a rendered chart
// unless you already know where these cities are, so it is asserted instead.
// -----------------------------------------------------------------------------

describe("place map", () => {
  /** Ray casting in lon/lat space — the basemap rings are plain [lng, lat]. */
  function inRing(lng: number, lat: number, ring: [number, number][]): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = at(ring, i);
      const [xj, yj] = at(ring, j);
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  const countryAt = (lng: number, lat: number): string | undefined =>
    BASEMAP.find((c) => c.rings.some((r) => inRing(lng, lat, r)))?.name;

  it("the simplified outline still puts real cities in the right country", () => {
    // Coordinates as the IWAC index geocodes them.
    const cities: [string, number, number, string][] = [
      ["Ouagadougou", -1.53388, 12.36566, "Burkina Faso"],
      ["Abidjan", -4.0083, 5.3364, "Côte d'Ivoire"],
      ["Cotonou", 2.4183, 6.3654, "Benin"],
      ["Niamey", 2.1098, 13.5116, "Niger"],
      ["Lagos", 3.3792, 6.5244, "Nigeria"],
      ["Bamako", -8.0029, 12.6392, "Mali"],
    ];
    for (const [name, lng, lat, expected] of cities) {
      assert.equal(countryAt(lng, lat), expected, `${name} fell in the wrong country`);
    }
  });

  it("the basemap covers the six IWAC countries and stays small", () => {
    const iwac = BASEMAP.filter((c) => c.iwac).map((c) => c.name).sort();
    assert.deepEqual(iwac, ["Benin", "Burkina Faso", "Côte d'Ivoire", "Niger", "Nigeria", "Togo"]);
    // It is inlined into every .mcpb; the simplification is what makes a map
    // possible under the app CSP at all.
    const points = BASEMAP.reduce((a, c) => a + c.rings.reduce((x, r) => x + r.length, 0), 0);
    assert.ok(points < 1200, `basemap has ${points} points; re-run scripts/make-basemap.mjs with a coarser tolerance`);
  });

  it("bubbles are area-proportional and clipped to the frame", () => {
    const svg = bubbleMap({
      countries: BASEMAP,
      bounds: BASEMAP_BOUNDS,
      points: [
        { label: "Ouagadougou", lat: 12.37, lng: -1.53, value: 1624 },
        { label: "Lomé", lat: 6.13, lng: 1.22, value: 406 },
        // Mecca is one of the most-named places in the corpus and is nowhere
        // near this frame; it must be dropped, not drawn at the edge.
        { label: "La Mecque", lat: 21.42, lng: 39.83, value: 1649 },
      ],
    });
    assert.equal((svg.match(/<circle/g) ?? []).length, 2, "an out-of-frame point was drawn");
    assert.ok(!svg.includes("La Mecque"));
    // 4x the count => 2x the radius, because area carries the value.
    const radii = [...svg.matchAll(/r="([\d.]+)"/g)].map((m) => Number(m[1]));
    const big = at(radii, 0);
    const small = at(radii, 1);
    assert.ok(Math.abs(big * big / (small * small) - 4) < 0.05, `radii ${radii} are not area-proportional`);
  });
});

describe("co-mention network", () => {
  const NODES = Array.from({ length: 12 }, (_, i) => ({ label: `n${i}`, weight: 100 - i * 5 }));
  // Two tight clusters, plus one bridge between them.
  const EDGES = [
    ...[0, 1, 2].flatMap((i) => [0, 1, 2].filter((j) => j > i).map((j) => ({ source: i, target: j, weight: 50 }))),
    ...[6, 7, 8].flatMap((i) => [6, 7, 8].filter((j) => j > i).map((j) => ({ source: i, target: j, weight: 50 }))),
    { source: 2, target: 6, weight: 5 },
  ];

  it("is deterministic — the same data always draws the same picture", () => {
    // A graph that reshuffles on every re-render cannot be read as evidence.
    const a = forceGraph({ nodes: NODES, edges: EDGES });
    const b = forceGraph({ nodes: NODES, edges: EDGES });
    assert.equal(a, b);
  });

  it("places tightly-linked nodes closer than unlinked ones", () => {
    const svg = forceGraph({ nodes: NODES, edges: EDGES });
    const centre = (i: number) => {
      const circles = [...svg.matchAll(/<circle cx="([\d.-]+)" cy="([\d.-]+)"/g)];
      const circle = at(circles, i);
      return { x: Number(circle[1]), y: Number(circle[2]) };
    };
    const d = (i: number, j: number) => Math.hypot(centre(i).x - centre(j).x, centre(i).y - centre(j).y);
    // Within-cluster distance must beat the across-cluster distance, or the
    // layout is telling the reader nothing.
    assert.ok(d(0, 1) < d(0, 7), `cluster mates ${d(0, 1).toFixed(0)} apart, rivals ${d(0, 7).toFixed(0)}`);
    assert.ok(d(6, 7) < d(6, 1));
    assert.ok(!svg.includes("NaN"));
  });

  it("survives degenerate inputs", () => {
    assert.equal(forceGraph({ nodes: [], edges: [] }), "");
    // One node, no edges: no division by zero, no NaN geometry.
    const solo = forceGraph({ nodes: [{ label: "only", weight: 1 }], edges: [] });
    assert.ok(solo.includes("<circle"));
    assert.ok(!solo.includes("NaN"));
    // Zero weights everywhere must not produce infinite radii.
    const flat = forceGraph({ nodes: [{ label: "a", weight: 0 }, { label: "b", weight: 0 }], edges: [{ source: 0, target: 1, weight: 0 }] });
    assert.ok(!flat.includes("NaN") && !flat.includes("Infinity"));
  });
});

describe("PCA projection", () => {
  it("recovers a planted 2-D structure from high-dimensional noise", () => {
    // Points on a known plane inside 40 dimensions, plus small noise on the
    // rest. PC1/PC2 must recover the plane and explain nearly all the variance.
    const D = 40;
    const vectors = [];
    for (let i = 0; i < 60; i++) {
      const a = Math.cos((i / 60) * Math.PI * 2) * 10;
      const b = Math.sin((i / 60) * Math.PI * 2) * 4;
      const v = new Array(D).fill(0).map((_, j) => (j % 7) * 1e-4 * ((i % 5) - 2));
      v[3] = a;
      v[17] = b;
      vectors.push(v);
    }
    const { points, explained } = project2d(vectors);
    assert.equal(points.length, 60);
    assert.ok(explained[0] + explained[1] > 0.99, `explained ${explained} should be ~1 for a planar cloud`);
    // The wider axis must come first.
    assert.ok(explained[0] > explained[1]);
    // The ring's shape survives: the spread along PC1 is ~10/4 that along PC2.
    const spread = (k: 0 | 1) => Math.max(...points.map((p) => p[k])) - Math.min(...points.map((p) => p[k]));
    assert.ok(Math.abs(spread(0) / spread(1) - 2.5) < 0.3, `aspect ${spread(0) / spread(1)}`);
  });

  it("is deterministic and sign-stable", () => {
    const vectors = Array.from({ length: 30 }, (_, i) =>
      Array.from({ length: 12 }, (_, j) => Math.sin(i * 0.7 + j) + (j === 2 ? i : 0)),
    );
    const a = project2d(vectors);
    const b = project2d(vectors);
    assert.deepEqual(a.points, b.points, "two runs on identical data must agree, including sign");
  });

  it("degrades safely", () => {
    assert.deepEqual(project2d([]).points, []);
    assert.deepEqual(project2d([[1, 2, 3]]).points, [[0, 0]]);
    // Identical vectors: zero variance, no NaN, no divide-by-zero.
    const same = project2d([
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
    ]);
    assert.equal(same.points.length, 3);
    assert.ok(same.points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
    assert.deepEqual(same.explained, [0, 0]);
  });
});
