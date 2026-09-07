import { equal, rejects } from "node:assert/strict";
import { test } from "node:test";
import { withFixtureScope } from "./_fixture-client.mjs";

test("fixture scope closes clients when test code throws", async () => {
  let client;
  const failure = new Error("simulated assertion failure");
  await rejects(withFixtureScope(async (scope) => {
    ({ client } = await scope.connect({ name: "cleanup-test", stderr: "ignore" }));
    equal((await client.listTools()).tools.length > 0, true);
    throw failure;
  }), (err) => err === failure);
  await rejects(client.callTool({ name: "search_articles", arguments: {} }), /not connected|closed/i);
});

test("early fixture cleanup is idempotent and preserves pinned protocol options", async () => {
  await withFixtureScope(async (scope) => {
    const session = await scope.connect({
      name: "cleanup-modern-test",
      stderr: "ignore",
      clientOptions: { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    });
    equal(session.client.getProtocolEra(), "modern");
    await session.close();
    await session.close();
    await rejects(session.client.callTool({ name: "search_articles", arguments: {} }), /not connected|closed/i);
  });
});

test("private mode reports its repository and actual OCR coverage", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "iwac-private-stats-"));
  const previous = process.env.IWAC_PRIVATE_DATASET;
  try {
    await fs.cp(new URL("./fixtures/", import.meta.url), path.join(base, "private-full"), { recursive: true });
    process.env.IWAC_PRIVATE_DATASET = "true";
    await withFixtureScope(async (scope) => {
      const { client } = await scope.connect({ name: "private-stats", cacheDir: base, stderr: "ignore" });
      const result = await client.callTool({ name: "get_collection_stats", arguments: {} });
      const payload = result.structuredContent ?? JSON.parse(result.content.find(c => c.type === "text").text);
      equal(payload.dataset_url, "https://huggingface.co/datasets/fmadore/islam-west-africa-collection-full");
      equal(payload.fulltext_note.startsWith("PRIVATE full mirror"), true);
      equal(payload.fulltext_coverage.articles.with_fulltext > 0, true);
    });
  } finally {
    if (previous === undefined) delete process.env.IWAC_PRIVATE_DATASET;
    else process.env.IWAC_PRIVATE_DATASET = previous;
    await fs.rm(base, { recursive: true, force: true });
  }
});
