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

test("every tool refuses unknown arguments instead of ignoring them", async () => {
  // A plain z.object strips unknown keys, so `keywords` (for `keyword`) used to
  // run an UNFILTERED search and return every article as if it had matched.
  await withFixtureScope(async (scope) => {
    const { client } = await scope.connect({ name: "strict-inputs", stderr: "ignore" });
    const { tools } = await client.listTools();
    const open = tools.filter((tool) => tool.inputSchema.additionalProperties !== false).map((tool) => tool.name);
    equal(open.join(", "), "", "tools whose input schema accepts unknown keys");

    const typo = await client.callTool({ name: "search_articles", arguments: { keywords: "laïcité", limit: 3 } });
    equal(typo.isError, true);
    equal(/keywords/.test(typo.content[0].text), true, "the error names the unknown key");
    const nested = await client.callTool({
      name: "explore_corpus",
      arguments: { mode: "items", selection: { keywords: "laïcité" } },
    });
    equal(nested.isError, true, "selection objects are strict too");
    const oversized = await client.callTool({
      name: "explore_corpus",
      arguments: { selection: { exact: { subject: Array.from({ length: 1_001 }, (_, i) => `s${i}`) } } },
    });
    equal(oversized.isError, true, "arguments over the element cap are refused");
    const overlong = await client.callTool({ name: "search_articles", arguments: { keyword: "x".repeat(2_001) } });
    equal(overlong.isError, true, "strings over the input bound are refused");
    equal(JSON.parse(overlong.content[0].text).code, "invalid_argument");
  });
});

test("keywords need every word; a quoted phrase or literal mode matches as written", async () => {
  await withFixtureScope(async (scope) => {
    const { client } = await scope.connect({ name: "keyword-semantics", stderr: "ignore" });
    const total = async (args) =>
      JSON.parse((await client.callTool({ name: "search_articles", arguments: args })).content[0].text).total_matches;
    // "Le pèlerinage à La Mecque vu de Cotonou": both words occur, not side by side.
    equal(await total({ keyword: "pèlerinage Cotonou" }) > 0, true, "every word, any order");
    equal(await total({ keyword: "Cotonou pèlerinage" }), await total({ keyword: "pèlerinage Cotonou" }));
    equal(await total({ keyword: '"pèlerinage Cotonou"' }), 0, "a quoted phrase must occur as written");
    equal(await total({ keyword: "pèlerinage Cotonou", keyword_mode: "literal" }), 0, "literal is the old rule");
    equal(await total({ keyword: '"La Mecque"' }) > 0, true);
    // One word means the same thing in every mode.
    equal(await total({ keyword: "ramadan" }), await total({ keyword: "ramadan", keyword_mode: "literal" }));
  });
});

test("an empty filtered search says so and suggests close stored values", async () => {
  await withFixtureScope(async (scope) => {
    const { client } = await scope.connect({ name: "empty-hints", stderr: "ignore" });
    const body = JSON.parse(
      (await client.callTool({ name: "search_articles", arguments: { subject: "Ramadhan", newspaper: "Sidwya" } }))
        .content[0].text,
    );
    equal(body.total_matches, 0);
    equal(typeof body.hint, "string");
    equal(body.did_you_mean.subject.includes("Ramadan"), true);
    equal(body.did_you_mean.newspaper.includes("Sidwaya"), true);
    const unfiltered = JSON.parse((await client.callTool({ name: "search_articles", arguments: {} })).content[0].text);
    equal("hint" in unfiltered, false, "no hint without filters or with matches");
    const missing = await client.callTool({ name: "get_article", arguments: { article_id: 999_999 } });
    equal(missing.isError, true);
    equal(JSON.parse(missing.content[0].text).code, "not_found");
  });
});

test("a linked export returns a resource link that reads the whole selection", async () => {
  await withFixtureScope(async (scope) => {
    const { client } = await scope.connect({ name: "export-link", stderr: "ignore" });
    const result = await client.callTool({ name: "explore_corpus", arguments: { mode: "csl_json", link: true } });
    equal(result.isError, undefined);
    const link = result.content.find((block) => block.type === "resource_link");
    equal(link.uri.startsWith("iwac://export/csl_json/articles/"), true);
    equal(result.structuredContent.rows.length, 0, "no citations in the conversation");
    const total = result.structuredContent.total_matches;
    const read = await client.readResource({ uri: link.uri });
    equal(JSON.parse(read.contents[0].text).length, total, "the file holds the whole selection");
    equal(JSON.parse(read.contents[1].text).provenance.snapshot_id.length, 64, "with its manifest");
    await rejects(client.readResource({ uri: "iwac://export/csl_json/articles/not-json" }), /base64url JSON|selection/);
  });
});

test("the research prompt completes its depth argument", async () => {
  await withFixtureScope(async (scope) => {
    const { client } = await scope.connect({ name: "prompt-completion", stderr: "ignore" });
    const ref = { type: "ref/prompt", name: "iwac_research" };
    equal((await client.complete({ ref, argument: { name: "depth", value: "e" } })).completion.values.join(), "extended");
    equal((await client.complete({ ref, argument: { name: "depth", value: "" } })).completion.values.join(), "brief,extended");
  });
});

test("entry tools stay loaded for hosts that defer tool loading", async () => {
  await withFixtureScope(async (scope) => {
    const { client } = await scope.connect({ name: "always-load", stderr: "ignore" });
    const { tools } = await client.listTools();
    const loaded = tools.filter((tool) => tool._meta?.["anthropic/alwaysLoad"] === true).map((tool) => tool.name);
    equal(loaded.sort().join(","), "fetch,get_collection_stats,search");
    equal(tools.filter((tool) => tool.annotations?.title).length, 0, "the title is not repeated in annotations");
  });
});

test("a tool profile registers only its tools and the instructions follow", async () => {
  await withFixtureScope(async (scope) => {
    const { client } = await scope.connect({ name: "profile", stderr: "ignore", env: { IWAC_TOOL_PROFILE: "search" } });
    const { tools } = await client.listTools();
    equal(tools.map((tool) => tool.name).sort().join(","), "fetch,get_collection_stats,search");
    const instructions = client.getInstructions?.() ?? "";
    equal(instructions.includes("explore_corpus"), false);
    equal(instructions.includes("get_temporal_distribution"), false);
    // A tool outside the profile answers like any unknown tool: a protocol error.
    await rejects(client.callTool({ name: "search_articles", arguments: {} }), /not found/);
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
      // The handshake and the research prompt must describe the mirror this
      // instance actually reads, not repeat the public dataset's masking.
      const instructions = client.getInstructions?.() ?? "";
      equal(instructions.includes("PRIVATE full mirror"), true);
      equal(instructions.includes("The public dataset omits restricted OCR"), false);
      const prompt = await client.getPrompt({ name: "iwac_research", arguments: { question: "q" } });
      const text = prompt.messages.map((m) => m.content.text ?? "").join("\n");
      equal(text.includes("private full mirror"), true);
      equal(text.includes("public dataset"), false);
    });
  } finally {
    if (previous === undefined) delete process.env.IWAC_PRIVATE_DATASET;
    else process.env.IWAC_PRIVATE_DATASET = previous;
    await fs.rm(base, { recursive: true, force: true });
  }
});
