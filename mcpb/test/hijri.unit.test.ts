// Unit tests for the Hijri (Umm al-Qura) inputs: month resolution, the column
// guard, the lunar filter and the lunar-month view. Split from the former
// test/unit.test.ts (November 2026); `npm run test:unit` runs it (tsx --test).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { lunarView } from "../src/app/views/lunar.js";
import { HIJRI_MONTHS, hijriFilter, requireHijriColumns, resolveHijriMonth } from "../src/tools/_shared.js";
import type { Bindable } from "../src/db.js";
import { at } from "./_must.js";

// -----------------------------------------------------------------------------
// Hijri (Umm al-Qura) inputs. The columns are precomputed by the pipeline, so
// the server's job is resolving what the model typed and refusing to guess.
// -----------------------------------------------------------------------------

describe("resolveHijriMonth", () => {
  it("accepts the month number", () => {
    assert.equal(resolveHijriMonth("9").n, 9);
    assert.equal(resolveHijriMonth("1").n, 1);
    assert.equal(resolveHijriMonth("12").n, 12);
  });

  it("accepts the academic transliteration the collection uses", () => {
    assert.equal(resolveHijriMonth("Ramadan").n, 9);
    assert.equal(resolveHijriMonth("Dhu al-Hijja").n, 12);
    assert.equal(resolveHijriMonth("Muharram").n, 1);
  });

  it("accepts the French forms the INSTRUCTIONS ask the model to query in", () => {
    // The server tells the model to formulate queries in French, so refusing
    // French month names would be refusing its own house style.
    assert.equal(resolveHijriMonth("Chaabane").n, 8);
    assert.equal(resolveHijriMonth("Chawwal").n, 10);
    assert.equal(resolveHijriMonth("Mouharram").n, 1);
    assert.equal(resolveHijriMonth("Dhou al-hijja").n, 12);
  });

  it("folds case and accents like every other filter", () => {
    assert.equal(resolveHijriMonth("RAMADAN").n, 9);
    assert.equal(resolveHijriMonth("  ramadan  ").n, 9);
    assert.equal(resolveHijriMonth("sha'ban").n, 8);
    assert.equal(resolveHijriMonth("Shaban").n, 8);
  });

  it("accepts common alternates a non-francophone user reaches for", () => {
    assert.equal(resolveHijriMonth("Rabi al-awwal").n, 3);
    assert.equal(resolveHijriMonth("Dhul-Hijjah").n, 12);
    assert.equal(resolveHijriMonth("Ramadhan").n, 9);
  });

  it("treats an absent value as no filter", () => {
    assert.deepEqual(resolveHijriMonth(undefined), {});
    assert.deepEqual(resolveHijriMonth("  "), {});
  });

  it("errors with valid_values rather than filtering to zero rows", () => {
    // A typo that returned 0 articles would be indistinguishable from a real
    // absence, which is the whole reason enum inputs are validated here.
    for (const bad of ["Ramadam", "0", "13", "-1", "Frimaire"]) {
      const r = resolveHijriMonth(bad);
      assert.equal(r.n, undefined, `${bad} should not resolve`);
      const err = r.err as { error: string; valid_values: string[] };
      assert.match(err.error, /Invalid hijri_month/);
      assert.equal(err.valid_values.length, 12);
      assert.ok(err.valid_values.includes("Ramadan"));
    }
  });

  it("resolves every month in the canonical table", () => {
    HIJRI_MONTHS.forEach((name, i) => {
      assert.equal(resolveHijriMonth(name).n, i + 1, `${name} should be month ${i + 1}`);
    });
  });
});

describe("requireHijriColumns", () => {
  it("passes when both columns are present", () => {
    const schema = new Set(["pub_date", "hijri_year", "hijri_month", "hijri_day"]);
    assert.equal(requireHijriColumns(schema, "articles"), undefined);
  });

  it("explains the absence instead of letting SQL fail on an unbound column", () => {
    const r = requireHijriColumns(new Set(["pub_date"]), "references");
    assert.ok(r, "missing columns should be reported");
    assert.match(r.error, /hijri_year, hijri_month/);
    assert.match(r.error, /references/);
    // The note has to name which subsets DO carry lunar dates, or the model
    // retries the same call on the same subset.
    assert.match(r.note, /not references/);
  });

  it("reports only the column that is actually missing", () => {
    const r = requireHijriColumns(new Set(["pub_date", "hijri_year"]), "articles");
    assert.ok(r);
    assert.match(r.error, /hijri_month/);
    assert.doesNotMatch(r.error, /hijri_year/);
  });
});

describe("hijriFilter", () => {
  it("binds month and year as parameters", () => {
    const where: string[] = [];
    const params: Bindable[] = [];
    hijriFilter(where, params, 9, 1445);
    assert.deepEqual(where, ["hijri_month = ?", "hijri_year = ?"]);
    assert.deepEqual(params, [9, 1445]);
  });

  it("adds nothing when neither is given", () => {
    const where: string[] = [];
    const params: Bindable[] = [];
    hijriFilter(where, params, undefined, undefined);
    assert.deepEqual(where, []);
    assert.deepEqual(params, []);
  });

  it("filters on one axis independently of the other", () => {
    const w1: string[] = [];
    const p1: Bindable[] = [];
    hijriFilter(w1, p1, 9, undefined);
    assert.deepEqual(w1, ["hijri_month = ?"]);
    assert.deepEqual(p1, [9]);

    const w2: string[] = [];
    const p2: Bindable[] = [];
    hijriFilter(w2, p2, undefined, 1445);
    assert.deepEqual(w2, ["hijri_year = ?"]);
    assert.deepEqual(p2, [1445]);
  });
});

describe("lunarView", () => {
  const payload = {
    view: "lunar",
    subset: "articles",
    granularity: "lunar_month",
    calendar: "hijri",
    total_matches: 120,
    dated_count: 100,
    imprecise_date_count: 20,
    month_labels: Object.fromEntries(HIJRI_MONTHS.map((m, i) => [String(i + 1).padStart(2, "0"), m])),
    distribution: { "01": 5, "07": 10, "09": 60, "11": 25 },
  };

  /** The x-axis text, in order, with the renderer's escaping undone. */
  function axisOf(body: string): string[] {
    return [...body.matchAll(/class="tick" text-anchor="middle">([^<]+)</g)].map((m) =>
      String(m[1]).replaceAll("&#39;", "'"),
    );
  }

  it("plots all twelve months even where a month is empty", () => {
    // A gap in the lunar year is a finding; dropping the bar would hide it, so
    // every month must hold an axis slot whether or not it has items.
    const axis = axisOf(lunarView(payload).body);
    assert.equal(axis.length, 12);
    // Ramadan (60 items) and Dhu al-Hijja (0) both appear.
    assert.ok(axis.includes("Ramadan"));
    assert.ok(axis.includes("Hijja"));
  });

  it("draws the even-split reference line the chart exists to compare against", () => {
    const v = lunarView(payload);
    assert.match(v.body, /class="refline"/);
    assert.match(v.body, /even split/);
  });

  it("names the peak month and its deviation in a note", () => {
    const notes = (lunarView(payload).notes ?? []).filter(Boolean).join(" ");
    assert.match(notes, /Ramadan leads at 60/);
    assert.match(notes, /\+\d+%/);
  });

  // Notes are escaped once, by the renderer. The view escaped the month name as
  // well, so a Mawlid query's peak read "Rabi&#39; I leads" on screen.
  it("leaves the peak month unescaped for the renderer to escape once", () => {
    const notes = (lunarView({ ...payload, distribution: { "03": 70, "09": 20 } }).notes ?? []).filter(Boolean).join(" ");
    assert.match(notes, /Rabi' I leads at 70/);
    assert.ok(!notes.includes("&#39;"), "the view pre-escaped a note");
  });

  it("reports imprecisely dated items as absent, not zero", () => {
    const notes = (lunarView(payload).notes ?? []).filter(Boolean).join(" ");
    assert.match(notes, /20 matching items carry a date too imprecise/);
    assert.match(notes, /not zero/);
  });

  it("offers to read the peak month's items", () => {
    const peak = (lunarView(payload).actions ?? []).find((a) => a.id === "peak");
    assert.ok(peak, "the peak action should exist");
    assert.match(peak.label, /Ramadan/);
  });

  it("routes the peak action to the shared reader with its original subset", () => {
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const ctx = {
      run: (tool: string, args: Record<string, unknown>) => void calls.push({ tool, args }),
      download: () => undefined,
    } as never;
    const actions = lunarView({ ...payload, subset: "publications" }).actions ?? [];
    actions.find((a) => a.id === "peak")?.run(ctx);
    assert.equal(at(calls, 0).tool, "explore_corpus");
    assert.equal(at(calls, 0).args.subset, "publications");
    assert.equal((at(calls, 0).args.selection as {hijri_month:string}).hijri_month, "09");
  });

  it("survives an empty distribution", () => {
    const v = lunarView({ view: "lunar", subset: "articles", distribution: {} });
    assert.ok(v.body.length > 0);
    assert.doesNotMatch(v.body, /NaN/);
  });

  // The measured distribution over the 12,220 fully-dated articles — every
  // month occupied, so every bar carries a tooltip.
  const REAL = [739, 667, 968, 738, 735, 725, 777, 877, 1747, 1462, 1052, 1733];
  const realPayload = {
    ...payload,
    distribution: Object.fromEntries(REAL.map((n, i) => [String(i + 1).padStart(2, "0"), n])),
  };

  it("shortens only the two labels that would collide, and only on the axis", () => {
    // Twelve labels share ~70 viewBox units each; "Dhu al-Qa'da" beside
    // "Dhu al-Hijja" measured as overlapping (a -0.9px gap). Shortening is
    // confined to the axis so the tooltip still gives the full name.
    const body = lunarView(realPayload).body.replaceAll("&#39;", "'");
    const axis = axisOf(lunarView(realPayload).body);
    assert.deepEqual(axis.slice(10), ["Qa'da", "Hijja"], "the two Dhu al- months should be shortened");
    assert.ok(!axis.includes("Dhu al-Qa'da"), "the long form should not reach the axis");
    // …but the full names still identify the bars.
    assert.match(body, /<title>Dhu al-Qa'da: /);
    assert.match(body, /<title>Dhu al-Hijja: /);
    // Every other month keeps its full name on the axis.
    assert.deepEqual(axis.slice(0, 10), HIJRI_MONTHS.slice(0, 10));
  });

  it("labels at most four bars directly", () => {
    // A number on every bar is the noise selective labelling exists to avoid:
    // 8 of these 12 months deviate by >=25%, which must fall back to the top 4.
    const direct = [...lunarView(realPayload).body.matchAll(/class="barlbl"/g)].length;
    assert.ok(direct > 0 && direct <= 4, `expected 1-4 direct labels, got ${direct}`);
  });
});
