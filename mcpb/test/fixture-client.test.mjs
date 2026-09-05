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
