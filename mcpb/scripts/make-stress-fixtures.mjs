// Generate STRESS parquet fixtures for the response half of the token budget
// test (test/token-budget.test.mjs).
//
// The ordinary fixtures (scripts/make-fixtures.mjs) are deliberately small —
// 2-7 rows per subset, short text — because they exist to check the server's
// STRUCTURE. Measuring response size against them would measure the fixtures,
// not the server: `search_articles(limit=100)` over 6 rows returns 6 rows.
//
// This script re-reads those fixtures and blows them up along the two axes that
// actually drive a response's token count:
//
//   * ROW COUNT — enough copies that every `limit` reaches its server-side cap
//     (the highest is 100, on search_articles / search_publications /
//     search_references / search_index), so a max-limit call really does return
//     max-limit rows;
//   * FIELD LENGTH — the text fields padded to the lengths the real corpus
//     actually carries (see the fill-rate figures in TODO.md), so a row costs
//     what a real row costs rather than what an invented one-liner costs.
//
// What it does NOT change is which fields are EMPTY: padding is applied only
// where the base row already had text, so the masked `OCR` on article 104, the
// blank `descriptionAI` on audiovisual and the caption-less images survive.
// Those absences are half of what makes the row sizes honest.
//
// Ids stay numeric (`"o:id" * 1000 + copy`) because the by-id tools take an
// INTEGER id — a '101-3' style suffix would be rejected before it ever reached
// the row.
//
// Output: test/fixtures-stress/<subset>/train-00000-of-00001.parquet
// Run indirectly via `npm run test:tokens`; requires a prior `make-fixtures`.
import { DuckDBInstance } from "@duckdb/node-api";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "test", "fixtures");
const destDir = path.join(root, "test", "fixtures-stress");

/** Rows per subset, floor. Above the largest server-side `limit` cap (100) so a
 * max-limit call is never quietly answered by a short table. */
const MIN_ROWS = 130;

/**
 * Target character length per text column, taken from the measured corpus
 * rather than invented (TODO.md, "Data Enrichment"):
 *
 *   OCR                — real issues run to ~278k tokens; anything past
 *                        CHARACTER_LIMIT (25 000 chars) exercises the same cap,
 *                        so 40k keeps the fixture small while still truncating.
 *   tableOfContents    — extracted TOCs average ~6.4k chars.
 *   descriptionAI      — the AI abstracts are "~500-char" per the tool docs.
 *   abstract           — reference abstracts run longer than the article ones.
 *   Description/title  — index glosses and titles are short; padded only enough
 *                        that a 100-row list is not artificially cheap.
 */
const TARGET_CHARS = {
  OCR: 40_000,
  tableOfContents: 6_400,
  descriptionAI: 500,
  description: 500,
  abstract: 1_500,
  Description: 300,
  title: 120,
};

/** Columns whose value must stay unique across copies (ids and the URLs built
 * from them); `"o:id"` is handled separately because it must stay numeric. */
const UNIQUE_SUFFIXED = ["identifier", "iwac_url"];

/** SQL that pads `col` to `target` chars by repeating its own text, leaving an
 * already-empty value empty so the fixtures' deliberate gaps survive. */
function padExpr(col, target) {
  const q = `"${col}"`;
  const copies = `(ceil(${target}::DOUBLE / (length(${q}) + 1))::INTEGER + 1)`;
  return `CASE WHEN length(trim(${q})) > 0 THEN left(repeat(${q} || ' ', ${copies}), ${target}) ELSE ${q} END`;
}

async function main() {
  const subsets = (await fs.readdir(srcDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  if (subsets.length === 0) throw new Error(`no fixtures in ${srcDir} — run scripts/make-fixtures.mjs first`);

  await fs.rm(destDir, { recursive: true, force: true });
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();

  for (const subset of subsets) {
    const src = path.join(srcDir, subset, "train-00000-of-00001.parquet").replaceAll("\\", "/");
    const read = `read_parquet('${src.replace(/'/g, "''")}')`;

    const described = await conn.runAndReadAll(`DESCRIBE SELECT * FROM ${read}`);
    const types = new Map(described.getRowObjects().map((r) => [String(r.column_name), String(r.column_type)]));
    const columns = [...types.keys()];
    const rowCount = Number(
      (await conn.runAndReadAll(`SELECT count(*) AS n FROM ${read}`)).getRowObjects()[0].n,
    );
    const copies = Math.ceil(MIN_ROWS / rowCount);

    const replacements = [];
    // Numeric even when the column is VARCHAR: the by-id tools parse it as an
    // integer, so uniqueness has to come from arithmetic, not a string suffix.
    if (types.has("o:id")) {
      replacements.push(`(("o:id"::BIGINT * 1000) + r)::${types.get("o:id")} AS "o:id"`);
    }
    for (const col of UNIQUE_SUFFIXED) {
      if (columns.includes(col)) {
        replacements.push(
          `CASE WHEN length(trim("${col}")) > 0 THEN "${col}" || '-' || r::VARCHAR ELSE "${col}" END AS "${col}"`,
        );
      }
    }
    for (const [col, target] of Object.entries(TARGET_CHARS)) {
      if (columns.includes(col)) replacements.push(`${padExpr(col, target)} AS "${col}"`);
    }

    const dir = path.join(destDir, subset);
    await fs.mkdir(dir, { recursive: true });
    const dest = path.join(dir, "train-00000-of-00001.parquet").replaceAll("\\", "/");
    await conn.run(
      `COPY (
         SELECT base.* REPLACE (${replacements.join(", ")})
         FROM ${read} AS base, range(0, ${copies}) AS t(r)
       ) TO '${dest.replace(/'/g, "''")}' (FORMAT PARQUET)`,
    );
  }

  console.log(`stress fixtures written to ${destDir} (>= ${MIN_ROWS} rows per subset)`);
}

main().catch((err) => {
  console.error("make-stress-fixtures failed:", err);
  process.exit(1);
});
