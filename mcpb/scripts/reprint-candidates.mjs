// Offline, bounded exact-cosine candidate generation. No claim of transmission.
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { DuckDBInstance } from "@duckdb/node-api";
const { values } = parseArgs({
  options: {
    input: { type: "string" },
    output: { type: "string" },
    subset: { type: "string", default: "articles" },
    column: { type: "string", default: "embedding_OCR" },
    threshold: { type: "string", default: "0.85" },
    "max-items": { type: "string", default: "2000" },
    "max-pairs": { type: "string", default: "10000" },
  },
});
if (!values.input || !values.output)
  throw new Error(
    "Usage: node scripts/reprint-candidates.mjs --input shard.parquet --output candidates.json [--threshold .85 --max-items 2000 --max-pairs 10000]",
  );
const threshold = Number(values.threshold),
  maxItems = Number(values["max-items"]),
  maxPairs = Number(values["max-pairs"]);
if (
  !Number.isFinite(threshold) ||
  threshold < -1 ||
  threshold > 1 ||
  !Number.isInteger(maxItems) ||
  maxItems < 1 ||
  !Number.isInteger(maxPairs) ||
  maxPairs < 1
)
  throw new Error("Invalid threshold or work limit");
if (!/^[a-z]+$/.test(values.subset)) throw new Error("Invalid subset");
const quote = (name) => `"${name.replaceAll('"', '""')}"`,
  db = await DuckDBInstance.create(":memory:"),
  conn = await db.connect();
try {
  const count = Number(
    (await conn.runAndReadAll("SELECT count(*) FROM read_parquet(?)", [values.input])).getRowsJS()[0][0],
  );
  if (count > maxItems)
    throw new Error(
      `Input has ${count} items, above --max-items ${maxItems}. Supply a scoped shard or explicitly budget more work.`,
    );
  const records = (
    await conn.runAndReadAll(
      `SELECT CAST("o:id" AS VARCHAR) AS id,title,pub_date,newspaper,${quote(values.column)} AS vector FROM read_parquet(?) ORDER BY "o:id"`,
      [values.input],
    )
  ).getRowObjectsJS();
  const kept = records.filter(
    (r) =>
      Array.isArray(r.vector) && r.vector.length && r.vector.every(Number.isFinite) && r.vector.some((v) => v !== 0),
  );
  for (const r of kept) {
    const scale = Math.max(...r.vector.map(Math.abs)),
      norm = Math.hypot(...r.vector.map((v) => v / scale));
    r.vector = r.vector.map((v) => v / scale / norm);
  }
  const pairs = [];
  let eligiblePairs = 0;
  for (let i = 0; i < kept.length; i++)
    for (let j = i + 1; j < kept.length; j++) {
      const a = kept[i],
        b = kept[j];
      if (a.vector.length !== b.vector.length) continue;
      eligiblePairs++;
      const score = a.vector.reduce((sum, v, k) => sum + v * b.vector[k], 0);
      if (score >= threshold) {
        if (pairs.length >= maxPairs)
          throw new Error(
            `More than ${maxPairs} candidate pairs; raise --max-pairs or threshold. No partial output written.`,
          );
        pairs.push({ a: a.id, b: b.id, cosine: score });
      }
    }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(values.input)) hash.update(chunk);
  const parent = new Map(kept.map((r) => [r.id, r.id]));
  const find = (id) => {
    while (parent.get(id) !== id) id = parent.get(id);
    return id;
  };
  for (const p of pairs) parent.set(find(p.a), find(p.b));
  const ids = new Set(pairs.flatMap((p) => [p.a, p.b]));
  const groups = new Map();
  for (const r of kept.filter((r) => ids.has(r.id))) {
    const key = find(r.id);
    if (!groups.has(key)) groups.set(key, []);
    groups
      .get(key)
      .push({
        id: `${values.subset}:${r.id}`,
        title: r.title,
        date: r.pub_date,
        newspaper: r.newspaper,
        url: `https://islam.zmo.de/s/afrique_ouest/item/${r.id}`,
      });
  }
  const result = {
    method:
      "exact cosine, undirected threshold graph; connected components are reading candidates, not verified reprints",
    threshold,
    subset: values.subset,
    embedding_column: values.column,
    input_sha256: hash.digest("hex"),
    total_items: count,
    valid_vectors: kept.length,
    invalid_vectors: count - kept.length,
    eligible_pairs: eligiblePairs,
    pairs,
    groups: [...groups.values()].map((g) => g.sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"))),
    created_at: new Date().toISOString(),
  };
  await writeFile(values.output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    `${pairs.length} candidate pairs in ${groups.size} groups; ${count - kept.length} invalid vectors excluded.`,
  );
} finally {
  conn.closeSync();
  db.closeSync();
}
