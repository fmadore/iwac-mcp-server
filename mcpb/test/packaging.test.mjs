import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bindingIsCurrent, lockedBinding, verifyIntegrity } from "../scripts/duckdb-bindings.mjs";
import { collectSkills } from "../scripts/collect-skills.mjs";
import { assertUnpublished } from "../scripts/release-guard.mjs";

const release = { tag: "v1.2.3", repository: "fmadore/iwac-mcp-server", version: "1.2.3", manifestVersion: "1.2.3", token: "test-token", sleep: async () => {} };

/** Answers in order, then repeats the last one: an outage keeps answering 503. */
const answering = (...outcomes) => async () => {
  const next = outcomes.length > 1 ? outcomes.shift() : outcomes[0];
  if (next instanceof Error) throw next;
  return new Response(null, { status: next });
};
const timeout = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

test("release guard permits two explicit 404s and never sends GitHub token to Registry", async () => {
  const requests = [];
  await assertUnpublished({ ...release, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return new Response(null, { status: 404 });
  } });
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /^https:\/\/api.github.com\//);
  assert.equal(requests[0].options.headers.Authorization, "Bearer test-token");
  assert.equal(requests[1].options.headers.Authorization, undefined);
  assert.match(requests[1].url, /versions\/1.2.3\?include_deleted=true$/);
});

for (const [name, outcomes, expected] of [
  ["GitHub release", [200], /GitHub release v1.2.3 already exists/],
  ["MCP Registry version", [404, 200], /MCP Registry version 1.2.3 already exists/],
  ["GitHub outage", [503], /GitHub release v1.2.3 preflight failed \(HTTP 503, 4 attempts\); refusing publication/],
  ["Registry outage", [404, 503], /MCP Registry version 1.2.3 preflight failed \(HTTP 503/],
  ["Registry that never answers", [404, timeout()], /MCP Registry version 1.2.3 preflight failed \(timed out after 20s, 4 attempts\)/],
  ["GitHub permission error", [403], /GitHub release v1.2.3 preflight failed \(HTTP 403, 1 attempt\)/],
]) {
  test(`release guard blocks ${name} before publication`, async () => {
    await assert.rejects(assertUnpublished({ ...release, fetchImpl: answering(...outcomes) }), expected);
  });
}

// v3.8.0 stopped here on one Registry timeout while the Registry was answering
// again minutes later. A lookup that says nothing about the version is retried.
test("release guard retries timeouts and 5xx, then trusts a definite 404", async () => {
  const waits = [];
  await assertUnpublished({ ...release, sleep: async (ms) => { waits.push(ms); }, fetchImpl: answering(404, timeout(), 502, 429, 404) });
  assert.deepEqual(waits, [5_000, 10_000, 20_000]);
});

test("release guard does not retry an answer that will not change", async () => {
  let calls = 0;
  await assert.rejects(assertUnpublished({ ...release, fetchImpl: async () => { calls++; return new Response(null, { status: 403 }); } }), /HTTP 403/);
  assert.equal(calls, 1);
});

test("release guard fails closed on network failure and version mismatch", async () => {
  await assert.rejects(assertUnpublished({ ...release, fetchImpl: async () => { throw new Error("network down"); } }), /network down/);
  await assert.rejects(assertUnpublished({ ...release, tag: "v9.9.9", fetchImpl: async () => { assert.fail("Must reject before network"); } }), /must match/);
});

test("binding tarball must match exact lockfile integrity", () => {
  const bytes = Buffer.from("native-package-archive");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  verifyIntegrity(bytes, integrity);
  assert.throws(() => verifyIntegrity(Buffer.from("tampered"), integrity), /integrity mismatch/);
  assert.throws(() => verifyIntegrity(bytes, "sha1-abc"), /sha512/);
});

test("binding lock entry cannot be missing or disagree with node-api", () => {
  const name = "@duckdb/node-bindings-win32-arm64";
  const lock = { packages: { "node_modules/@duckdb/node-api": { version: "1.5.6-r.1" }, [`node_modules/${name}`]: { version: "1.5.6-r.1", integrity: "sha512-test" } } };
  assert.equal(lockedBinding(name, lock).version, "1.5.6-r.1");
  lock.packages[`node_modules/${name}`].version = "1.5.4-r.1";
  assert.throws(() => lockedBinding(name, lock), /must have integrity and match/);
  assert.throws(() => lockedBinding(name, {}), /must have integrity and match/);
  assert.throws(() => lockedBinding("@duckdb/../../malicious", lock), /Unsupported/);
});

test("stale and partial native binding installs are repaired, not reused", () => {
  const dir = mkdtempSync(join(tmpdir(), "iwac-binding-test-"));
  const name = "@duckdb/node-bindings-darwin-arm64";
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.5.4-r.1" }));
    writeFileSync(join(dir, "duckdb.node"), "fixture");
    writeFileSync(join(dir, "libduckdb.dylib"), "fixture");
    assert.equal(bindingIsCurrent(dir, name, "1.5.6-r.1"), false);
    assert.equal(bindingIsCurrent(dir, name, "1.5.4-r.1"), true);
    rmSync(join(dir, "libduckdb.dylib"));
    assert.equal(bindingIsCurrent(dir, name, "1.5.4-r.1"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Docker-like build context without research skill fails loudly", () => {
  const dir = mkdtempSync(join(tmpdir(), "iwac-missing-skill-"));
  try {
    const pkg = join(dir, "mcpb");
    mkdirSync(pkg);
    assert.throws(() => collectSkills(pkg), /research skill directory is missing/);
    mkdirSync(join(dir, ".agents/skills"), { recursive: true });
    assert.throws(() => collectSkills(pkg), /iwac-mcp research skill is missing/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
