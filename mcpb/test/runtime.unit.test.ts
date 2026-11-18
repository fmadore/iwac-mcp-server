// Unit tests for the runtime plumbing: environment and configuration parsing,
// the per-request server factory's schema memo, the DuckDB query helpers and
// their concurrency cap, and checked index reads. Split from the former
// test/unit.test.ts (November 2026); `npm run test:unit` runs it (tsx --test).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { rowsToMap } from "../src/tools/_shared.js";
import { activeQueries, MAX_ACTIVE_QUERIES, q, query, selectList } from "../src/db.js";
import { dropSafeIntegerBounds, memoizeJsonSchema } from "../src/tools/register.js";
import { z } from "zod";
import { envString, parseAllowedOrigins, parsePositiveInt, parseRefreshHours } from "../src/config.js";
import { at, must } from "./_must.js";
import { itemAt } from "../src/checked.js";

describe("configuration parsing", () => {
  it("accepts only complete positive decimal integers", () => {
    assert.equal(parsePositiveInt("8080", 8000), 8080);
    assert.equal(parsePositiveInt(" 768 ", 1), 768);
    for (const bad of [undefined, "", "0", "-1", "3.5", "1e3", "8000junk", "Infinity"]) {
      assert.equal(parsePositiveInt(bad, 42), 42, `${String(bad)} should fall back`);
    }
    assert.equal(parsePositiveInt("65536", 8000, 65_535), 8000);
  });

  it("reads IWAC_REFRESH_HOURS as whole hours, 0 to disable", () => {
    assert.equal(parseRefreshHours(undefined), 24);
    assert.equal(parseRefreshHours("6"), 6);
    assert.equal(parseRefreshHours(" 0 "), 0);
    // A typo must not silently turn the refresh off.
    for (const bad of ["", "-1", "1.5", "daily", "0x10"]) {
      assert.equal(parseRefreshHours(bad), 24, `${bad} should fall back`);
    }
  });

  it("normalises exact HTTP(S) origins and reports unsafe entries", () => {
    const parsed = parseAllowedOrigins(
      "https://ChatGPT.com/, http://localhost:3000, https://chatgpt.com:443, *, https://example.com/path, file:///tmp",
    );
    assert.deepEqual([...parsed.allowed], ["https://chatgpt.com", "http://localhost:3000"]);
    assert.deepEqual(parsed.invalid, ["*", "https://example.com/path", "file:///tmp"]);
  });

  // An optional extension setting left blank arrives as its literal template.
  it("treats blank values and unexpanded launcher templates as unset", () => {
    const name = "IWAC_TEST_ENV_STRING";
    // The literal `${…}` text is the input under test, not a missed template.
    const templates = ["$" + "{user_config.hf_token}", "$" + "{HOME}/.iwac-mcp/cache"];
    try {
      for (const unset of [undefined, "", "   ", ...templates]) {
        if (unset === undefined) delete process.env[name];
        else process.env[name] = unset;
        assert.equal(envString(name), undefined, `${String(unset)} should read as unset`);
      }
      process.env[name] = "  hf_abc123  ";
      assert.equal(envString(name), "hf_abc123");
    } finally {
      delete process.env[name];
    }
  });
});

describe("memoizeJsonSchema (per-request server factory)", () => {
  const convert = (schema: z.ZodType, io: "input" | "output") =>
    (schema["~standard"] as unknown as { jsonSchema: Record<typeof io, (o: unknown) => Record<string, unknown>> })
      .jsonSchema[io]({ target: "draft-2020-12" });
  it("returns what a fresh conversion returns, as a new object every call", () => {
    const schema = z.object({ q: z.string().describe("query"), n: z.number().int().optional() });
    const fresh = dropSafeIntegerBounds(convert(schema, "input"));
    memoizeJsonSchema(schema);
    const a = convert(schema, "input");
    const b = convert(schema, "input");
    assert.deepEqual(a, fresh);
    assert.notEqual(a, b);
    // One caller mutating its copy must not leak into the next caller's.
    (a.properties as Record<string, unknown>).q = "clobbered";
    assert.deepEqual(convert(schema, "input"), fresh);
    assert.deepEqual(
      convert(schema, "output"),
      dropSafeIntegerBounds(z.toJSONSchema(schema, { target: "draft-2020-12", io: "output" })),
    );
  });
  // ~20 tokens per integer field, 64 fields: the always-on budget paid ~1,200
  // tokens for bounds no argument comes near.
  it("drops only zod's implicit safe-integer bounds, at any depth", () => {
    const schema = z.object({
      id: z.number().int(),
      limit: z.number().int().min(1).max(50),
      nested: z.object({ ids: z.array(z.number().int().min(0)) }),
    });
    memoizeJsonSchema(schema);
    const props = convert(schema, "input").properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(props.id, { type: "integer" });
    assert.equal(must(props.limit, "limit").minimum, 1);
    assert.equal(must(props.limit, "limit").maximum, 50);
    const items = must((must(props.nested, "nested").properties as Record<string, Record<string, unknown>>).ids, "ids").items;
    assert.deepEqual(items, { type: "integer", minimum: 0 });
    // Validation is the zod schema's, untouched: an unsafe integer still fails.
    assert.equal(schema.safeParse({ id: 2 ** 60, limit: 5, nested: { ids: [] } }).success, false);
  });
  it("ignores values without a Standard JSON Schema hook and is idempotent", () => {
    memoizeJsonSchema(undefined);
    memoizeJsonSchema({});
    const schema = z.object({ a: z.string() });
    memoizeJsonSchema(schema);
    memoizeJsonSchema(schema);
    assert.deepEqual(convert(schema, "input"), z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }));
  });
});

describe("db helpers", () => {
  it("q quotes identifiers and doubles embedded quotes", () => {
    assert.equal(q("Titre alternatif"), '"Titre alternatif"');
    assert.equal(q('we"ird'), '"we""ird"');
  });
  it("selectList keeps only columns present in the schema", () => {
    const schema = new Set(["title", "o:id", "pub_date"]);
    const sql = selectList(schema, [
      ['"o:id"', "id", ["o:id"]],
      "title",
      "missing",
      ["pub_date", "date", ["pub_date"]],
      ["expr", "gone", ["absent_col"]],
    ]);
    assert.equal(sql, '"o:id" AS "id", "title", pub_date AS "date"');
  });
  it("rowsToMap skips empty keys and coerces counts", () => {
    const rows = [
      { k: "Benin", c: 5n },
      { k: "", c: 3 },
      { k: null, c: 2 },
      { k: "Togo", c: "7" },
    ];
    assert.deepEqual(rowsToMap(rows as Record<string, unknown>[]), { Benin: 5, Togo: 7 });
  });
  // One shared connection ran one statement at a time, so a trivial lookup
  // waited out any scan already in flight: search's Promise.all fan-out ran
  // serially, and on the HTTP endpoint one caller's full-text scan stalled
  // everyone else's requests.
  it("query does not queue behind a statement already running", async () => {
    const finished: string[] = [];
    const slow = query(
      "SELECT count(*) AS n FROM range(8000000) t(x) WHERE strip_accents(lower(CAST(x AS VARCHAR))) LIKE '%99999%'",
    ).then(() => finished.push("slow"));
    await new Promise((resolve) => setTimeout(resolve, 50)); // let the scan start first
    await query("SELECT 1 AS one").then(() => finished.push("fast"));
    await slow;
    assert.deepEqual(finished, ["fast", "slow"]);
  });
  it("caps queries in flight and serves the overflow in turn", async () => {
    const n = MAX_ACTIVE_QUERIES * 2 + 3;
    let peak = 0;
    const runs = Array.from({ length: n }, (_, i) =>
      query("SELECT ? AS i, count(*) AS c FROM range(200000)", [i]).then((rows) => {
        peak = Math.max(peak, activeQueries());
        return Number(at(rows, 0).i);
      }),
    );
    peak = Math.max(peak, activeQueries());
    assert.equal(peak, MAX_ACTIVE_QUERIES, "the burst should fill the cap and not exceed it");
    assert.deepEqual(await Promise.all(runs), Array.from({ length: n }, (_, i) => i));
    assert.equal(activeQueries(), 0, "every slot is released");
  });
});

describe("itemAt (checked index reads)", () => {
  it("returns the element in range and names the list when the proof is wrong", () => {
    assert.equal(itemAt([4, 0, 2], 1), 0, "a falsy element is still an element");
    assert.equal(itemAt(new Float32Array([1, 2]), 1), 2);
    assert.throws(() => itemAt([1, 2], 2), { name: "RangeError", message: "index 2 outside a list of 2" });
    assert.throws(() => itemAt([], 0), RangeError);
  });
});
