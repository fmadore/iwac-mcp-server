// Hermetic MCP round-trip test: spawns the BUILT server (server/index.js)
// against the synthetic fixtures (scripts/make-fixtures.mjs) with
// IWAC_OFFLINE=1 — no network, no real dataset, runs in seconds. Asserts the
// server's STRUCTURAL behavior (tool wiring, envelopes, enum errors, accent
// folding, pipe-aware filters, truncation, structuredContent parity); the live
// smoke-test.mjs remains the dataset-drift alarm.
//
// Run via `npm run test:fixture` (regenerates fixtures first). Requires a prior
// `npm run build`.
//
// The checks live in test/fixture-server/, one module per domain. They share
// one server connection and run in this file's order: later sections reuse the
// handshake's results and must run after the shared client is closed.
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness, createReporter } from "./_harness.mjs";
import { withFixtureScope } from "./_fixture-client.mjs";
import { degradedCacheChecks, handshakeChecks, modernEraChecks } from "./fixture-server/protocol.mjs";
import { searchChecks } from "./fixture-server/search.mjs";
import { statsChecks } from "./fixture-server/stats.mjs";
import { aggregateChecks } from "./fixture-server/aggregates.mjs";
import { sentimentChecks } from "./fixture-server/sentiment.mjs";
import { collectionChecks } from "./fixture-server/collections.mjs";

await withFixtureScope(async (fixtures) => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const reporter = createReporter();

  const { client, close: closeClient } = await fixtures.connect({ name: "fixture-test" });

  const { call, fail } = createHarness(client, { timeoutMs: 60_000, reporter });

  const ctx = { root, reporter, fixtures, client, call, fail };
  const legacy = await handshakeChecks(ctx);
  await searchChecks(ctx);
  await statsChecks(ctx);
  await aggregateChecks(ctx);
  await sentimentChecks(ctx);
  await collectionChecks(ctx);

  await closeClient();

  await degradedCacheChecks(ctx);
  await modernEraChecks(ctx, legacy);

  const total = reporter.failures();
  console.log(`\n${total === 0 ? "ALL FIXTURE CHECKS PASSED" : `${total} FIXTURE CHECK(S) FAILED`}`);
  process.exitCode = total === 0 ? 0 : 1;
});
