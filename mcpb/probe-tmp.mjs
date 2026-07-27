import { DuckDBInstance } from "@duckdb/node-api";
import { homedir } from "node:os";
import { join } from "node:path";
const c = await (await DuckDBInstance.create(":memory:")).connect();
const g = `read_parquet('${join(homedir(), ".iwac-mcp", "cache", "articles", "*.parquet").replaceAll("\\", "/")}')`;
await c.run(`CREATE VIEW a AS SELECT * FROM ${g}`);
const q = async (label, sql) => {
  const t0 = Date.now();
  try {
    const r = await c.runAndReadAll(sql);
    console.log(`\n${label} (${Date.now() - t0}ms):`);
    for (const o of r.getRowObjectsJS().slice(0, 6)) {
      console.log("  ", JSON.stringify(o, (k, v) => (typeof v === "bigint" ? Number(v) : v)).slice(0, 140));
    }
  } catch (e) {
    console.log(`\n${label}: ERROR ${String(e.message).split("\n")[0].slice(0, 130)}`);
  }
};

await q(
  "C: MATERIALIZED source",
  `WITH src AS MATERIALIZED (
     SELECT "o:id" AS id, title, embedding_OCR AS v FROM a WHERE embedding_OCR IS NOT NULL
   ), t AS MATERIALIZED (SELECT v FROM src WHERE id = '10076')
   SELECT id, substr(title, 1, 50) AS title, ROUND(list_inner_product(v, (SELECT v FROM t)), 4) AS score
   FROM src WHERE id <> '10076' ORDER BY score DESC LIMIT 6`,
);

await q(
  "D: fixed-size array cast",
  `WITH src AS MATERIALIZED (
     SELECT "o:id" AS id, title, CAST(embedding_OCR AS DOUBLE[768]) AS v FROM a WHERE embedding_OCR IS NOT NULL
   ), t AS MATERIALIZED (SELECT v FROM src WHERE id = '10076')
   SELECT id, substr(title, 1, 50) AS title, ROUND(array_cosine_similarity(v, (SELECT v FROM t)), 4) AS score
   FROM src WHERE id <> '10076' ORDER BY score DESC LIMIT 6`,
);
