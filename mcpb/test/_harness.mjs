// Shared MCP tool-call harness for the two round-trip test scripts
// (test/fixture-server.test.mjs — hermetic; smoke-test.mjs — live dataset).
// Previously each kept its own ~50-line copy of call()/fail() that had quietly
// diverged; the shared version takes the differences as options.

/**
 * Build a { call, fail, failures } harness bound to a connected MCP client.
 *
 * options:
 *   verbose   — log a one-line preview of every response (the live smoke test's
 *               behaviour; the fixture test stays quiet)
 *   timeoutMs — per-call timeout (fixtures are instant; live HF queries aren't)
 */
export function createHarness(client, { verbose = false, timeoutMs = 60_000 } = {}) {
  let failures = 0;
  function fail(msg) {
    failures++;
    console.error(`  FAIL: ${msg}`);
  }

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
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
    const body = res.content?.[0]?.text ?? "";
    const isErr = res.isError === true;
    if (verbose) {
      const preview = body.slice(0, 220).replace(/\s+/g, " ");
      console.log(`\n[${name}] ${isErr ? "ERROR " : ""}${body.length} chars | ${preview}${body.length > 220 ? "..." : ""}`);
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

  return { call, fail, failures: () => failures };
}

/**
 * Assert that manifest.json's advertised tools[] track what the server actually
 * registers: every registered tool must be advertised, and every advertised
 * tool must be registered — except the two semantic_search_* tools, which the
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
