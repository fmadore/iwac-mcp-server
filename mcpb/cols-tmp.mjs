import { DuckDBInstance } from "@duckdb/node-api";
import { homedir } from "node:os";
import { join } from "node:path";
const base = join(homedir(), ".iwac-mcp", "cache");
const c = await (await DuckDBInstance.create(":memory:")).connect();
const g = (s) => `read_parquet('${join(base, s, "*.parquet").replaceAll("\\", "/")}')`;
const q = async (l, sql) => { const r = await c.runAndReadAll(sql);
  console.log(`\n--- ${l} ---`); for (const o of r.getRowObjects().slice(0,14)) console.log(JSON.stringify(o,(k,v)=>typeof v==="bigint"?Number(v):v)); };
await q("languages", `SELECT trim(x) lang, COUNT(*) c FROM ${g("articles")}, unnest(str_split(language,'|')) t(x)
  WHERE NULLIF(trim(x),'') IS NOT NULL GROUP BY 1 ORDER BY c DESC`);
await q("non-french lexical", `SELECT trim(x) lang, COUNT(*) c, ROUND(AVG("Lisibilite_OCR"),1) lisib, ROUND(AVG("Richesse_Lexicale_OCR"),3) mattr
  FROM ${g("articles")}, unnest(str_split(language,'|')) t(x) WHERE trim(x) NOT IN ('fr','fre','French','français') GROUP BY 1 ORDER BY c DESC LIMIT 8`);
await q("subject cooccurrence top", `WITH s AS (SELECT "o:id" id, trim(x) v FROM ${g("articles")}, unnest(str_split(subject,'|')) t(x) WHERE NULLIF(trim(x),'') IS NOT NULL)
  SELECT a.v, b.v, COUNT(*) c FROM s a JOIN s b ON a.id=b.id AND a.v<b.v GROUP BY 1,2 ORDER BY c DESC LIMIT 6`);
await q("spatial top", `SELECT trim(x) v, COUNT(*) c FROM ${g("articles")}, unnest(str_split(spatial,'|')) t(x)
  WHERE NULLIF(trim(x),'') IS NOT NULL GROUP BY 1 ORDER BY c DESC LIMIT 8`);
