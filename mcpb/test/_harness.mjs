// Shared MCP tool-call harness for the two round-trip test scripts
// (test/fixture-server.test.mjs — hermetic; smoke-test.mjs — live dataset).
// Previously each kept its own ~50-line copy of call()/fail() that had quietly
// diverged; the shared version takes the differences as options.
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const MCPB_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The newest mtime under `dir` (recursively), or 0 if it does not exist. */
function newestMtime(dir) {
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    newest = Math.max(newest, e.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs);
  }
  return newest;
}

/**
 * Refuse to test a stale bundle. Every round-trip suite spawns the BUILT
 * server/index.js, and `npm test` does not build first (deliberately: CI's
 * runtime-floor job runs a Node 24 build on an older Node). So editing src/
 * and running the tests used to test the previous build, and pass or fail for
 * reasons that had nothing to do with the edit. Throws with the fix.
 */
export function assertFreshBuild() {
  let built;
  try {
    built = statSync(path.join(MCPB_ROOT, "server", "index.js")).mtimeMs;
  } catch {
    throw new Error("server/index.js does not exist: run `npm run build` before the round-trip tests.");
  }
  const sources = [
    path.join(MCPB_ROOT, "src"),
    path.join(MCPB_ROOT, "scripts", "bundle.mjs"),
    path.join(MCPB_ROOT, "scripts", "collect-skills.mjs"),
    path.join(MCPB_ROOT, "package.json"),
    // The skill files are inlined into the bundle too.
    path.join(MCPB_ROOT, "..", ".agents", "skills"),
  ];
  const newest = Math.max(
    ...sources.map((p) => {
      try {
        return statSync(p).isDirectory() ? newestMtime(p) : statSync(p).mtimeMs;
      } catch {
        return 0;
      }
    }),
  );
  if (newest > built) {
    throw new Error(
      "server/index.js is older than its sources (src/, the bundle scripts or the skill files): " +
        "run `npm run build` first, or these tests exercise the previous build.",
    );
  }
}

/**
 * How many tools a server with semantic search off must register: the tools
 * manifest.json declares, minus the optional semantic_search_* ones. Derived
 * rather than hard-coded, so adding a tool means touching the manifest, not
 * three copies of a number in three suites.
 */
export function expectedToolCount() {
  const manifest = JSON.parse(readFileSync(path.join(MCPB_ROOT, "manifest.json"), "utf8"));
  return manifest.tools.filter((t) => !t.name.startsWith("semantic_search_")).length;
}

/**
 * One failure counter for a whole suite. Every harness a suite builds (one per
 * client: legacy era, modern era, degraded cache) reports into it, so nothing
 * is summed by hand, and leaving a sub-harness out of the sum can no longer
 * hide its failures.
 */
export function createReporter() {
  let count = 0;
  return {
    fail(msg) {
      count++;
      console.error(`  FAIL: ${msg}`);
    },
    failures: () => count,
  };
}

/**
 * Build a { call, fail, failures, tokenReport } harness bound to a connected
 * MCP client.
 *
 * options:
 *   verbose   — log a one-line preview of every response (the live smoke test's
 *               behaviour; the fixture test stays quiet)
 *   timeoutMs — per-call timeout (fixtures are instant; live HF queries aren't)
 *   encode + tokenCeiling — when both are given, count every response in tokens,
 *               fail any call over the ceiling, and collect a report. This is
 *               the half of the token budget that synthetic fixtures cannot
 *               honestly cover: the aggregate tools' response size is driven by
 *               the corpus's CARDINALITY (distinct months, subjects, places), so
 *               only the live dataset shows their real worst case. The
 *               deterministic half lives in test/token-budget.test.mjs. The
 *               encoder is passed in rather than imported here so the hermetic
 *               fixture test never loads its megabytes of BPE ranks.
 */
export function createHarness(
  client,
  { verbose = false, timeoutMs = 60_000, encode = null, tokenCeiling = 0, reporter = createReporter() } = {},
) {
  const { fail } = reporter;

  const responseTokens = [];

  /**
   * Call a tool and run assertions. opts:
   *   expectError — the call SHOULD return isError (default false)
   *   structured — the tool declares an outputSchema, so the result must carry a
   *     structuredContent that exactly mirrors the text block
   *   check(parsed, body, res) — runs on successfully parsed results only;
   *     return a failure message or falsy
   *   checkBody(body) — runs on the raw text regardless of error state (use to
   *     assert the shape of an expected error, e.g. valid_values / valid_categories)
   */
  async function call(name, args, opts = {}) {
    // SDK v2 dropped the result-schema parameter: the signature is
    // `callTool(params, options)`, not v1's `(params, resultSchema, options)`.
    // Left as three arguments, `undefined` IS the options object and `timeoutMs`
    // is silently ignored — which capped the live smoke test at the 60s default
    // instead of the 5 minutes it asks for, and read as a dataset hang.
    const res = await client.callTool({ name, arguments: args }, { timeout: timeoutMs });
    const body = res.content?.[0]?.text ?? "";
    const isErr = res.isError === true;
    if (verbose) {
      const preview = body.slice(0, 220).replace(/\s+/g, " ");
      console.log(`\n[${name}] ${isErr ? "ERROR " : ""}${body.length} chars | ${preview}${body.length > 220 ? "..." : ""}`);
    }
    if (encode && tokenCeiling) {
      // Counted on the WHOLE payload a client receives, not just content[0]:
      // an over-budget answer is over budget however it is split into blocks.
      const whole = res.content?.map((c) => c.text ?? "").join("") ?? "";
      const tokens = encode(whole).length;
      responseTokens.push({ name, args, tokens });
      if (tokens > tokenCeiling) {
        fail(`${name}(${JSON.stringify(args)}): response is ${tokens} tokens, over the ${tokenCeiling} ceiling`);
      }
    }
    if (isErr !== (opts.expectError ?? false)) {
      fail(`${name}(${JSON.stringify(args)}): isError=${isErr}, expected ${opts.expectError ?? false} — ${body.slice(0, 200)}`);
      return null;
    }
    let parsed = null;
    if (!isErr) {
      try {
        parsed = JSON.parse(body);
      } catch {
        fail(`${name}: response is not valid JSON`);
        return null;
      }
      if (opts.structured) {
        if (!res.structuredContent) fail(`${name}: missing structuredContent (outputSchema declared)`);
        else if (JSON.stringify(res.structuredContent) !== JSON.stringify(parsed))
          fail(`${name}: structuredContent does not mirror the text block`);
      }
    }
    if (opts.check && parsed) {
      const msg = opts.check(parsed, body, res);
      if (msg) fail(`${name}: ${msg}`);
    }
    if (opts.checkBody) {
      const msg = opts.checkBody(body);
      if (msg) fail(`${name}: ${msg}`);
    }
    return parsed;
  }

  /** Print the heaviest responses seen, so the live run leaves a record of what
   * the real corpus costs even when nothing crossed the ceiling. */
  function tokenReport(top = 15) {
    if (!responseTokens.length) return;
    const sorted = [...responseTokens].sort((a, b) => b.tokens - a.tokens);
    console.log(`\nheaviest responses (o200k_base, ceiling ${tokenCeiling}):`);
    for (const r of sorted.slice(0, top)) {
      console.log(`  ${String(r.tokens).padStart(6)}  ${r.name} ${JSON.stringify(r.args)}`.slice(0, 160));
    }
    const total = responseTokens.reduce((s, r) => s + r.tokens, 0);
    console.log(`  ${responseTokens.length} calls, ${total} tokens total, median ${sorted[Math.floor(sorted.length / 2)].tokens}`);
  }

  return { call, fail, failures: reporter.failures, tokenReport };
}

/**
 * Assert that manifest.json's advertised tools[] track what the server actually
 * registers: every registered tool must be advertised, and every advertised
 * tool must be registered — except the semantic_search_* tools, which the
 * manifest always advertises but the server only registers when
 * IWAC_SEMANTIC_SEARCH_ENABLED is on.
 */
export function checkManifestParity(fail, manifest, registeredNames) {
  const manifestNames = new Set(manifest.tools.map((t) => t.name));
  for (const n of registeredNames) {
    if (!manifestNames.has(n)) fail(`tool ${n} is registered but missing from manifest.json tools[]`);
  }
  for (const n of manifestNames) {
    const optional = n.startsWith("semantic_search_");
    if (!registeredNames.has(n) && !optional) fail(`manifest.json advertises ${n} but the server does not register it`);
  }
}
