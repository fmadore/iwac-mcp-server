// Evaluate an explicitly configured provider against researcher-authored judgments.
// judgments: [{query, subset:"articles", relevant_ids:["101", "articles:102"]}]
import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
const { values } = parseArgs({
  options: { judgments: { type: "string" }, output: { type: "string" }, k: { type: "string", default: "10" } },
});
if (!values.judgments || !values.output)
  throw new Error(
    "Usage: node scripts/evaluate-retrieval.mjs --judgments judgments.json --output evaluation.json [--k 10]. Uses explicitly configured IWAC embedding provider.",
  );
const k = Number(values.k);
if (!Number.isInteger(k) || k < 1 || k > 50) throw new Error("k must be 1–50");
const judgments = JSON.parse(await readFile(values.judgments, "utf8"));
if (!Array.isArray(judgments) || !judgments.length) throw new Error("Provide a nonempty judgment array");
const client = new Client({ name: "iwac-retrieval-evaluation", version: "1.0" }),
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../server/index.js", import.meta.url).pathname],
    env: { ...process.env, IWAC_SEMANTIC_SEARCH_ENABLED: "true" },
    stderr: "inherit",
  });
const reports = [];
try {
  await client.connect(transport);
  for (const example of judgments) {
    const subset = example.subset ?? "articles";
    if (
      !["articles", "publications", "images"].includes(subset) ||
      typeof example.query !== "string" ||
      !Array.isArray(example.relevant_ids) ||
      !example.relevant_ids.length
    )
      throw new Error("Each judgment needs query, supported subset, and nonempty relevant_ids");
    const relevant = new Set(example.relevant_ids.map((id) => String(id).split(":").at(-1)));
    const started = performance.now();
    const response = await client.callTool({
      name: `semantic_search_${subset}`,
      arguments: { query: example.query, limit: k },
    });
    if (response.isError) throw new Error(response.content[0]?.text ?? "Retrieval failed");
    const payload = response.structuredContent ?? JSON.parse(response.content[0].text);
    const results = payload.results ?? payload.articles ?? payload.publications ?? payload.images ?? [];
    const ids = results.map((r) => String(r.id).split(":").at(-1));
    const hits = ids.filter((id) => relevant.has(id)).length;
    const dcg = ids.reduce((v, id, i) => v + (relevant.has(id) ? 1 / Math.log2(i + 2) : 0), 0),
      ideal = Array.from({ length: Math.min(k, relevant.size) }, (_, i) => 1 / Math.log2(i + 2)).reduce(
        (a, b) => a + b,
        0,
      );
    reports.push({
      query: example.query,
      subset,
      k,
      ids,
      recall_at_k: hits / relevant.size,
      precision_at_k: hits / k,
      ndcg_at_k: dcg / ideal,
      latency_ms: performance.now() - started,
      provenance: response._meta?.["islam.zmo.de/provenance"],
    });
  }
  const mean = (key) => reports.reduce((n, r) => n + r[key], 0) / reports.length;
  await writeFile(
    values.output,
    `${JSON.stringify({ method: "binary relevance; use held-out French, English, name-variant and sparse-coverage queries", queries: reports.length, k, mean_recall_at_k: mean("recall_at_k"), mean_ndcg_at_k: mean("ndcg_at_k"), results: reports }, null, 2)}\n`,
  );
} finally {
  await client.close();
  await transport.close();
}
