// Hermetic round-trip test for the remote Streamable-HTTP transport
// (`node server/index.js --http`) — the path the Docker/GHCR deployment runs.
// Covers what the stdio fixture test cannot: bearer-token auth, the
// refuse-to-start-without-token guard, /health, the 4 MB body cap, 404s, and a
// real MCP call through StreamableHTTPClientTransport. Uses the same synthetic
// fixtures + IWAC_OFFLINE=1, so it needs no network and runs in seconds.
//
// Run via `npm run test:http` (regenerates fixtures first). Requires a prior
// `npm run build`.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { assertFreshBuild, createHarness, createReporter, expectedToolCount } from "./_harness.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverJs = path.join(root, "server", "index.js");
const PORT = 18432;
const TOKEN = "test-token-fixture-http";
const ALLOWED_ORIGIN = "https://trusted.example";
const BASE = `http://127.0.0.1:${PORT}`;
const TOOL_COUNT = expectedToolCount();
const PACKAGE_VERSION = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
/** Advertised in the main server's Server Card; the wildcard server runs without it. */
const PUBLIC_URL = "https://mcp.example.test/mcp";
assertFreshBuild();

const baseEnv = {
  ...process.env,
  IWAC_CACHE_DIR: path.join(root, "test", "fixtures"),
  IWAC_OFFLINE: "1",
  IWAC_SEMANTIC_SEARCH_ENABLED: "false",
  PORT: String(PORT),
  // Point the token file somewhere that never exists so only the env var counts.
  IWAC_MCP_TOKEN_FILE: path.join(root, "test", "fixtures", "no-such-token-file"),
  IWAC_MCP_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
};

const reporter = createReporter();
const { fail } = reporter;

// --- 1. Without a token the server must refuse to start (exit 1) --------------
{
  const env = { ...baseEnv };
  delete env.IWAC_MCP_BEARER_TOKEN;
  const child = spawn(process.execPath, [serverJs, "--http"], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise((resolve) => child.on("exit", resolve));
  if (code !== 1) fail(`tokenless --http should exit 1, exited ${code}`);
  if (!stderr.includes("bearer token")) fail(`tokenless --http should explain the missing token, got: ${stderr.slice(0, 200)}`);
}

// --- 1b. The private mirror is never served over HTTP by accident ------------
// The shared deployment is public, so IWAC_PRIVATE_DATASET alone must refuse to
// start; the explicit second opt-in is what lets it through.
{
  const env = { ...baseEnv, IWAC_MCP_BEARER_TOKEN: TOKEN, IWAC_PRIVATE_DATASET: "true" };
  delete env.IWAC_ALLOW_PRIVATE_HTTP;
  const child = spawn(process.execPath, [serverJs, "--http"], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise((resolve) => child.on("exit", resolve));
  if (code !== 1) fail(`--http in private mode without the opt-in should exit 1, exited ${code}`);
  if (!stderr.includes("IWAC_ALLOW_PRIVATE_HTTP")) {
    fail(`private --http should name the opt-in it needs, got: ${stderr.slice(0, 200)}`);
  }
}

// --- 1c. `*` is an opt-in on its own, and never with the private mirror -------
// With the private mirror, any page could read restricted text through a
// visitor's browser if the token were added on the way (an nginx injecting it),
// so the server refuses even with IWAC_ALLOW_PRIVATE_HTTP. A `*` mixed into a
// list is a typo, not an opt-in, and stays invalid.
for (const [origins, privateMirror, expected] of [
  ["*", "true", "IWAC_MCP_ALLOWED_ORIGINS=*"],
  [`*, ${ALLOWED_ORIGIN}`, "false", "invalid origins"],
  ["https://*.example", "false", "invalid origins"],
]) {
  const env = {
    ...baseEnv,
    IWAC_MCP_BEARER_TOKEN: TOKEN,
    IWAC_MCP_ALLOWED_ORIGINS: origins,
    IWAC_PRIVATE_DATASET: privateMirror,
    IWAC_ALLOW_PRIVATE_HTTP: privateMirror,
  };
  const child = spawn(process.execPath, [serverJs, "--http"], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise((resolve) => child.on("exit", resolve));
  if (code !== 1) fail(`IWAC_MCP_ALLOWED_ORIGINS='${origins}' (private=${privateMirror}) should exit 1, exited ${code}`);
  if (!stderr.includes(expected)) fail(`'${origins}' should be refused with '${expected}', got: ${stderr.slice(0, 200)}`);
}

// --- 1d. A malformed IWAC_MCP_PUBLIC_URL would publish a broken endpoint ------
for (const publicUrl of ["/mcp", "https://user:secret@mcp.example.test/mcp", "https://mcp.example.test/mcp?x=1"]) {
  const env = { ...baseEnv, IWAC_MCP_BEARER_TOKEN: TOKEN, IWAC_MCP_PUBLIC_URL: publicUrl };
  const child = spawn(process.execPath, [serverJs, "--http"], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise((resolve) => child.on("exit", resolve));
  if (code !== 1) fail(`IWAC_MCP_PUBLIC_URL='${publicUrl}' should exit 1, exited ${code}`);
  if (!stderr.includes("IWAC_MCP_PUBLIC_URL")) fail(`'${publicUrl}' should be refused by name, got: ${stderr.slice(0, 200)}`);
}

/** Wait until the server on `base` answers /health. */
async function waitHealthy(base) {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.status === 200 && (await res.text()) === "ok") return true;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return false;
}

/** A CORS preflight as a browser sends it: no Authorization, ever. */
const preflight = (base, origin) =>
  fetch(`${base}/mcp`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, content-type, mcp-protocol-version, mcp-method",
    },
  });

// --- 2. Start the real server and wait for /health -----------------------------
const server = spawn(process.execPath, [serverJs, "--http"], {
  env: { ...baseEnv, IWAC_MCP_BEARER_TOKEN: TOKEN, IWAC_MCP_PUBLIC_URL: `${PUBLIC_URL}/` },
  stdio: ["ignore", "ignore", "inherit"],
});
try {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      up = res.status === 200 && (await res.text()) === "ok";
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!up) {
    fail("server did not become healthy within 10s");
    process.exit(1);
  }

  // --- 3. Transport-level checks (raw fetch) -----------------------------------
  const noAuth = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (noAuth.status !== 401) fail(`unauthenticated /mcp should 401, got ${noAuth.status}`);
  if (noAuth.headers.get("www-authenticate") !== "Bearer") fail("401 should carry WWW-Authenticate: Bearer");

  const badAuth = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
    body: "{}",
  });
  if (badAuth.status !== 401) fail(`wrong token should 401, got ${badAuth.status}`);

  // MCP 2026-07-28 requires Origin validation on every Streamable-HTTP
  // connection. Origin-less server clients remain valid; a browser origin must
  // be explicitly allowlisted and is checked before bearer authentication.
  const badOrigin = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
      Origin: "https://attacker.example",
    },
    body: "{}",
  });
  if (badOrigin.status !== 403) fail(`untrusted Origin should 403, got ${badOrigin.status}`);
  const allowedOrigin = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ALLOWED_ORIGIN },
    body: "{}",
  });
  if (allowedOrigin.status !== 401) fail(`allowlisted Origin should proceed to auth and 401, got ${allowedOrigin.status}`);
  // A loopback page needs no allowlist entry; a look-alike host still does.
  for (const [origin, expected] of [["http://localhost:5173", 401], ["http://127.0.0.1", 401], ["http://localhost.attacker.example", 403]]) {
    const local = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: "{}" });
    if (local.status !== expected) fail(`Origin ${origin} should answer ${expected}, got ${local.status}`);
  }

  // CORS. Passing the Origin check is useless to a browser unless the
  // preflight is answered (before auth: it never carries the token) and every
  // response names the origin.
  const allowedPreflight = await preflight(BASE, ALLOWED_ORIGIN);
  if (allowedPreflight.status !== 204) fail(`allowlisted preflight should 204, got ${allowedPreflight.status}`);
  if (allowedPreflight.headers.get("access-control-allow-origin") !== ALLOWED_ORIGIN) {
    fail(`preflight should allow ${ALLOWED_ORIGIN}, got ${allowedPreflight.headers.get("access-control-allow-origin")}`);
  }
  const allowedHeaders = (allowedPreflight.headers.get("access-control-allow-headers") ?? "").toLowerCase().split(/,\s*/);
  for (const header of ["content-type", "authorization", "accept", "mcp-protocol-version", "mcp-session-id", "mcp-method", "mcp-name", "last-event-id"]) {
    if (!allowedHeaders.includes(header)) fail(`preflight should allow request header ${header}, got '${allowedHeaders}'`);
  }
  if (!(allowedPreflight.headers.get("access-control-allow-methods") ?? "").includes("POST")) fail("preflight should allow POST");
  if (!Number(allowedPreflight.headers.get("access-control-max-age"))) fail("preflight should carry Access-Control-Max-Age");
  if (allowedPreflight.headers.get("vary") !== "Origin") fail("preflight should carry Vary: Origin");
  if (allowedPreflight.headers.has("access-control-allow-credentials")) fail("never send Access-Control-Allow-Credentials");
  const loopbackPreflight = await preflight(BASE, "http://localhost:5173");
  if (loopbackPreflight.status !== 204 || loopbackPreflight.headers.get("access-control-allow-origin") !== "http://localhost:5173") {
    fail(`loopback preflight should 204 and name its origin, got ${loopbackPreflight.status}`);
  }
  const deniedPreflight = await preflight(BASE, "https://attacker.example");
  if (deniedPreflight.status !== 403) fail(`untrusted preflight should 403, got ${deniedPreflight.status}`);
  if (deniedPreflight.headers.has("access-control-allow-origin")) fail("a refused origin must get no CORS headers");
  if (badOrigin.headers.has("access-control-allow-origin")) fail("a refused origin's POST must get no CORS headers");
  // Actual responses: this file's own 401 and 400, and none without Origin.
  const corsCheck = (res, label) => {
    if (res.headers.get("access-control-allow-origin") !== ALLOWED_ORIGIN) fail(`${label} should carry Access-Control-Allow-Origin`);
    if (res.headers.get("vary") !== "Origin") fail(`${label} should carry Vary: Origin`);
    if (!/WWW-Authenticate/i.test(res.headers.get("access-control-expose-headers") ?? "")) {
      fail(`${label} should expose WWW-Authenticate and the MCP headers`);
    }
    if (res.headers.has("access-control-allow-credentials")) fail(`${label} must not allow credentials`);
  };
  corsCheck(allowedOrigin, "the 401 to an allowlisted origin");
  if (noAuth.headers.has("access-control-allow-origin")) fail("an Origin-less request should get no CORS headers");
  const corsParseError = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, Origin: ALLOWED_ORIGIN },
    body: "not json",
  });
  if (corsParseError.status !== 400) fail(`parse error with Origin should 400, got ${corsParseError.status}`);
  corsCheck(corsParseError, "a 400 to an allowlisted origin");
  // The SDK handler's own responses: a success and its 405 for GET.
  const corsSuccess = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Origin: ALLOWED_ORIGIN,
      Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "cors", method: "tools/list", params: {
      _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} },
    } }),
  });
  if (corsSuccess.status !== 200) fail(`tools/list with an allowlisted Origin should 200, got ${corsSuccess.status}`);
  corsCheck(corsSuccess, "an SDK success to an allowlisted origin");
  await corsSuccess.body?.cancel();
  const corsGet = await fetch(`${BASE}/mcp`, { headers: { Authorization: `Bearer ${TOKEN}`, Origin: ALLOWED_ORIGIN } });
  if (corsGet.status !== 405) fail(`GET /mcp should 405, got ${corsGet.status}`);
  corsCheck(corsGet, "the SDK's 405 to an allowlisted origin");
  await corsGet.body?.cancel();

  // Claude hashes the connector URL exactly as typed, trailing slash included,
  // and refuses to render a view whose `_meta.ui.domain` does not match. The
  // endpoint answers on both /mcp and /mcp/, so each must get its own value.
  {
    const { createHash } = await import("node:crypto");
    const expected = (url) => `${createHash("sha256").update(url).digest("hex").slice(0, 32)}.claudemcpcontent.com`;
    for (const [path, connectorUrl] of [["/mcp", PUBLIC_URL], ["/mcp/", `${PUBLIC_URL}/`]]) {
      for (const uri of ["ui://iwac/charts.html", "ui://iwac/charts-wide.html"]) {
        const res = await fetch(`${BASE}${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json",
            Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "resources/read",
            "Mcp-Name": uri,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: "domain", method: "resources/read", params: {
            uri, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} },
          } }),
        });
        const body = await res.json().catch(() => ({}));
        const domain = body.result?.contents?.[0]?._meta?.ui?.domain;
        if (domain !== expected(connectorUrl))
          fail(`${uri} read via ${path} should name ${expected(connectorUrl)} (hash of ${connectorUrl}), got ${domain ?? JSON.stringify(body).slice(0, 200)}`);
      }
    }
  }

  // The v2 handler owns protocol/media validation. These raw checks guard the
  // adapter boundary around it, including the local pre-parsing of JSON bodies.
  const wrongMediaType = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: "{}",
  });
  if (wrongMediaType.status !== 415) fail(`non-JSON MCP POST should 415, got ${wrongMediaType.status}`);

  const parseSentinel = "not-json-DO_NOT_REFLECT";
  const invalidJson = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: parseSentinel,
  });
  const invalidJsonBody = await invalidJson.text();
  if (invalidJson.status !== 400) fail(`invalid JSON should 400, got ${invalidJson.status}`);
  if (!invalidJsonBody.includes('"code":-32700') || !invalidJsonBody.includes('"message":"Parse error"')) {
    fail(`invalid JSON should return a stable JSON-RPC parse error, got ${invalidJsonBody.slice(0, 200)}`);
  }
  if (invalidJsonBody.includes(parseSentinel)) fail("parse error reflected attacker-controlled request text");

  // --- 3b. Server Card (SEP-2127): public, cacheable, nothing operational -----
  // Served before the bearer check and with `*` CORS for every caller, as
  // ext-server-card's docs/discovery.md requires, while POST /mcp still
  // demands the token (checked above and again here, after the card).
  const card = await fetch(`${BASE}/mcp/server-card`, { headers: { Origin: ALLOWED_ORIGIN, Accept: "application/mcp-server-card+json" } });
  const cardText = await card.text();
  if (card.status !== 200) fail(`GET /mcp/server-card without a token should 200, got ${card.status}`);
  if (card.headers.get("content-type") !== "application/mcp-server-card+json") {
    fail(`server card Content-Type should be application/mcp-server-card+json, got ${card.headers.get("content-type")}`);
  }
  if (card.headers.get("access-control-allow-origin") !== "*") fail("server card should carry Access-Control-Allow-Origin: *");
  if (!/\bETag\b/i.test(card.headers.get("access-control-expose-headers") ?? "")) fail("server card should expose ETag");
  if (card.headers.has("access-control-allow-credentials")) fail("server card must not allow credentials");
  if (card.headers.get("cache-control") !== "public, max-age=3600") fail(`server card Cache-Control is '${card.headers.get("cache-control")}'`);
  const cardEtag = card.headers.get("etag");
  if (!cardEtag || !/^"[^"]+"$/.test(cardEtag)) fail(`server card should carry a strong ETag, got '${cardEtag}'`);
  let cardJson = {};
  try {
    cardJson = JSON.parse(cardText);
  } catch {
    fail(`server card is not JSON: ${cardText.slice(0, 200)}`);
  }
  // The v1 schema's required members and patterns (schema.ts, ext-server-card).
  if (cardJson.$schema !== "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json") fail(`card $schema is '${cardJson.$schema}'`);
  if (cardJson.name !== "io.github.fmadore/iwac-mcp-server") fail(`card name is '${cardJson.name}'`);
  if (cardJson.version !== PACKAGE_VERSION) fail(`card version ${cardJson.version} should be the build's ${PACKAGE_VERSION}`);
  if (typeof cardJson.description !== "string" || cardJson.description.length < 1 || cardJson.description.length > 100) {
    fail("card description must be 1 to 100 characters");
  }
  const remote = cardJson.remotes?.[0];
  if (cardJson.remotes?.length !== 1 || remote?.type !== "streamable-http" || remote?.url !== PUBLIC_URL) {
    fail(`card should advertise the one IWAC_MCP_PUBLIC_URL remote, got ${JSON.stringify(cardJson.remotes)}`);
  }
  if (remote?.headers !== undefined) fail("the card must not ask clients for headers (no token is ever published)");
  for (const leak of [TOKEN, "islam-west-africa-collection", "fixtures", "cache", "tools", "capabilities", "/run/secrets"]) {
    if (cardText.toLowerCase().includes(leak.toLowerCase())) fail(`server card leaks operational detail: ${leak}`);
  }
  // A disallowed origin gets the card too: it is the same public document.
  const foreignCard = await fetch(`${BASE}/mcp/server-card`, { headers: { Origin: "https://attacker.example" } });
  if (foreignCard.status !== 200 || foreignCard.headers.get("access-control-allow-origin") !== "*") {
    fail(`server card should be readable from any origin, got ${foreignCard.status}`);
  }
  await foreignCard.body?.cancel();
  const cardRevalidated = await fetch(`${BASE}/mcp/server-card`, { headers: { "If-None-Match": cardEtag ?? "" } });
  if (cardRevalidated.status !== 304) fail(`If-None-Match with the card's ETag should 304, got ${cardRevalidated.status}`);
  if ((await cardRevalidated.text()) !== "") fail("a 304 must have no body");
  const cardHead = await fetch(`${BASE}/mcp/server-card`, { method: "HEAD" });
  if (cardHead.status !== 200 || cardHead.headers.get("etag") !== cardEtag) fail(`HEAD /mcp/server-card should 200 with the ETag, got ${cardHead.status}`);
  const cardPreflight = await fetch(`${BASE}/mcp/server-card`, {
    method: "OPTIONS",
    headers: { Origin: "https://anywhere.example", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "if-none-match" },
  });
  if (cardPreflight.status !== 204 || cardPreflight.headers.get("access-control-allow-origin") !== "*") {
    fail(`server card preflight should 204 with '*', got ${cardPreflight.status}`);
  }
  if (!/If-None-Match/i.test(cardPreflight.headers.get("access-control-allow-headers") ?? "")) fail("card preflight should allow If-None-Match");
  const cardPost = await fetch(`${BASE}/mcp/server-card`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (cardPost.status !== 405 || !(cardPost.headers.get("allow") ?? "").includes("GET")) {
    fail(`POST /mcp/server-card should 405 with Allow, got ${cardPost.status} '${cardPost.headers.get("allow")}'`);
  }
  await cardPost.body?.cancel();
  const stillLocked = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (stillLocked.status !== 401) fail(`POST /mcp without a token should still 401 next to the card, got ${stillLocked.status}`);
  // The card's modern-era versions must be exactly what server/discover
  // reports: the SDK keeps that list internal, so serverCard.ts names it, and
  // the spec tells clients to trust server/discover when the two disagree.
  const discover = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json",
      Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "server/discover",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "discover", method: "server/discover", params: {
      _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} },
    } }),
  });
  const discovered = (await discover.json())?.result?.supportedVersions;
  const cardModern = (remote?.supportedProtocolVersions ?? []).filter((v) => v >= "2026-07-28");
  if (!Array.isArray(discovered) || JSON.stringify(cardModern) !== JSON.stringify(discovered)) {
    fail(`card modern versions ${JSON.stringify(cardModern)} differ from server/discover ${JSON.stringify(discovered)}`);
  }
  if (!(remote?.supportedProtocolVersions ?? []).includes("2025-11-25")) fail("card should list the 2025-era versions too");

  const notFound = await fetch(`${BASE}/nope`, { method: "POST" });
  if (notFound.status !== 404) fail(`unknown path should 404, got ${notFound.status}`);

  const tooLarge = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: "x".repeat(4 * 1024 * 1024 + 1024),
  }).catch(() => null);
  // The 413 is best-effort (the server also closes the connection); accept
  // either the status or a reset, but never a 2xx.
  if (tooLarge && tooLarge.status !== 413) fail(`>4MB body should 413 (or reset), got ${tooLarge.status}`);

  // --- 4. Full MCP round-trip over Streamable HTTP ------------------------------
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  const client = new Client({ name: "http-test", version: "0.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  if (tools.tools.length !== TOOL_COUNT) {
    fail(`expected ${TOOL_COUNT} tools over HTTP with semantic off, got ${tools.tools.length}`);
  }

  // Skills over MCP on the remote leg. This transport is the whole reason the
  // skill is served from the server at all — there is no release artifact to
  // download at islam.zmo.de/mcp — so the capability and the methods are
  // asserted here and not only on stdio, even though one factory builds both.
  const httpCaps = client.getServerCapabilities();
  if (httpCaps?.extensions?.["io.modelcontextprotocol/skills"] === undefined) {
    fail("the skills capability is not declared over HTTP");
  }
  if (!httpCaps?.tools || !httpCaps?.resources) fail("declaring extensions dropped capabilities over HTTP");
  // The lists are fixed at build time. Advertising listChanged would invite a
  // modern client to hold a subscriptions/listen stream open for nothing.
  for (const kind of ["tools", "resources", "prompts"]) {
    if (httpCaps?.[kind]?.listChanged !== false) {
      fail(`${kind}.listChanged should be false over HTTP, got ${httpCaps?.[kind]?.listChanged}`);
    }
  }
  const httpSkills = await client.request({ method: "skills/list", params: {} }, z.looseObject({}));
  if (httpSkills.skills?.[0]?.uri !== "skill://iwac-mcp/SKILL.md") {
    fail(`skills/list over HTTP returned '${httpSkills.skills?.[0]?.uri}'`);
  }
  if ((httpSkills.skills?.[0]?.resources ?? []).length !== 5) {
    fail(`skills/list over HTTP: manifest has ${httpSkills.skills?.[0]?.resources?.length} files, expected 5`);
  }

  const { call } = createHarness(client, { timeoutMs: 60_000, reporter });
  await call("search_articles", { country: "Bénin" }, {
    check: (p) => (p.total_matches === 2 ? null : `accented Bénin over HTTP should match 2, got ${p.total_matches}`),
  });
  await call("get_collection_stats", {}, {
    structured: true,
    check: (p) => (p.subset_counts?.articles === 6 ? null : "collection stats wrong over HTTP"),
  });
  await call("search_articles", { country: "Atlantis" }, {
    expectError: true,
    checkBody: (b) => (b.includes("valid_values") ? null : "invalid country should error with valid_values over HTTP"),
  });

  await client.close();
  await transport.close();

  // --- 5. The 2026-07-28 era over the same endpoint -----------------------------
  // The client above used the default `versionNegotiation` — the 2025
  // `initialize` handshake — so it proves only the legacy leg. `createMcpHandler`
  // is supposed to serve BOTH eras from one factory; pin the modern revision so
  // there is no fallback to hide a regression, then re-run the legacy leg above
  // to prove the endpoint is still dual-era.
  const modernTransport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  const modern = new Client(
    { name: "http-test-modern", version: "0.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await modern.connect(modernTransport);

  if (modern.getProtocolEra() !== "modern") {
    fail(`pinned 2026-07-28 over HTTP should negotiate the modern era, got ${modern.getProtocolEra()}`);
  }

  const modernTools = await modern.listTools();
  if (modernTools.tools.length !== TOOL_COUNT) {
    fail(`expected ${TOOL_COUNT} tools on the modern era, got ${modernTools.tools.length}`);
  }
  // CacheableResult (SEP-2549): required on list results from 2026-07-28. The
  // SDK defaults to ttlMs 0 / private, so a 0 here means our cacheHints were
  // dropped, not that the field is missing.
  if (modernTools.ttlMs !== 3_600_000 || modernTools.cacheScope !== "public") {
    fail(`tools/list should carry our cache hints, got ttlMs=${modernTools.ttlMs} cacheScope=${modernTools.cacheScope}`);
  }

  // Final Skills extension contracts must survive the modern HTTP adapter too.
  const skillEntry = z.looseObject({
    uri: z.string(),
    frontmatter: z.looseObject({ name: z.string(), description: z.string() }),
    resources: z.array(z.looseObject({
      uri: z.string(), digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      size: z.number().int().nonnegative(),
    })),
  });
  const skillCache = {
    ttlMs: z.number().int().positive(), cacheScope: z.literal("public"),
  };
  // SDK Client.request unwraps resultType, so inspect the actual wire separately.
  const skillWire = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json",
      Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "skills/list",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "skills-wire", method: "skills/list", params: {
      _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} },
    } }),
  });
  const skillWireBody = await skillWire.json();
  if (skillWire.status !== 200 || skillWireBody.result?.resultType !== "complete") {
    fail(`modern skills/list wire envelope is invalid: ${JSON.stringify(skillWireBody)}`);
  }
  const modernSkills = await modern.request(
    { method: "skills/list", params: {} }, z.looseObject({ ...skillCache, skills: z.array(skillEntry).min(1) }),
  );
  const modernSkill = await modern.request(
    { method: "skills/get", params: { uri: modernSkills.skills[0].uri } },
    z.looseObject({ ...skillCache, skill: skillEntry }),
  );
  if (JSON.stringify(modernSkill.skill) !== JSON.stringify(modernSkills.skills[0])) {
    fail("modern HTTP skills/get and skills/list manifests differ");
  }

  const { call: modernCall } = createHarness(modern, { timeoutMs: 60_000, reporter });
  await modernCall("get_collection_stats", {}, {
    structured: true,
    check: (p) => (p.subset_counts?.articles === 6 ? null : "collection stats wrong on the modern era"),
  });

  await modern.close();
  await modernTransport.close();

  const anonymousMetrics = await fetch(`${BASE}/metrics`);
  if (anonymousMetrics.status !== 401) fail("metrics must require the bearer token");
  const metrics = await fetch(`${BASE}/metrics`,{headers:{Authorization:`Bearer ${TOKEN}`}}).then(r=>r.json());
  if (!Number.isFinite(metrics.active_queries) || metrics.requests.completed < 1 || !Number.isFinite(metrics.requests.p95_ms)) fail("metrics are missing queue/latency measurements");
  // The invalid-country calls above failed; `completed` counts them too.
  if (!(metrics.requests.failed >= 1) || metrics.requests.failed >= metrics.requests.completed) {
    fail(`metrics should count failed calls apart, got failed=${metrics.requests.failed} completed=${metrics.requests.completed}`);
  }

  // --- 7. SIGTERM drains in-flight requests instead of cutting them ------------
  // Hold a request open by sending its body in two halves, signal between
  // them, then finish it. A server that exits on the signal resets the socket;
  // one that drains answers the request and then exits cleanly.
  const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const drained = new Promise((resolve) => {
    const req = http.request(
      `${BASE}/mcp`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Content-Length": Buffer.byteLength(rpc),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", (err) => resolve(`error: ${err.code ?? err.message}`));
    req.write(rpc.slice(0, 10));
    setTimeout(() => {
      server.kill("SIGTERM");
      setTimeout(() => req.end(rpc.slice(10)), 300);
    }, 200);
  });
  const status = await drained;
  if (status !== 200) fail(`a request in flight at SIGTERM should still be answered, got ${status}`);
  const exitCode = await new Promise((resolve) => {
    if (server.exitCode !== null) resolve(server.exitCode);
    else server.on("exit", (code) => resolve(code));
  });
  if (exitCode !== 0) fail(`server should exit 0 after draining, got ${exitCode}`);
} finally {
  if (server.exitCode === null) server.kill("SIGTERM");
}

// --- 8. `IWAC_MCP_ALLOWED_ORIGINS=*` on the public mirror ---------------------
{
  const WILD_BASE = `http://127.0.0.1:${PORT + 1}`;
  const wild = spawn(process.execPath, [serverJs, "--http"], {
    env: { ...baseEnv, PORT: String(PORT + 1), IWAC_MCP_BEARER_TOKEN: TOKEN, IWAC_MCP_ALLOWED_ORIGINS: "*" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  try {
    if (!(await waitHealthy(WILD_BASE))) fail("wildcard-origin server did not become healthy within 10s");
    else {
      const anyPreflight = await preflight(WILD_BASE, "https://anywhere.example");
      if (anyPreflight.status !== 204 || anyPreflight.headers.get("access-control-allow-origin") !== "*") {
        fail(`wildcard preflight should 204 with '*', got ${anyPreflight.status} '${anyPreflight.headers.get("access-control-allow-origin")}'`);
      }
      const anyPost = await fetch(`${WILD_BASE}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://anywhere.example" },
        body: "{}",
      });
      // Any origin passes the Origin check; the token is still required.
      if (anyPost.status !== 401) fail(`wildcard mode should still demand the token, got ${anyPost.status}`);
      if (anyPost.headers.get("access-control-allow-origin") !== "*") fail("wildcard mode should answer Access-Control-Allow-Origin: *");
      if (anyPost.headers.has("access-control-allow-credentials")) fail("wildcard mode must never allow credentials");
      // Without IWAC_MCP_PUBLIC_URL the card still identifies the server but
      // omits remotes: the schema allows only absolute URLs there.
      const bareCard = await fetch(`${WILD_BASE}/mcp/server-card`).then((r) => r.json());
      if (bareCard.name !== "io.github.fmadore/iwac-mcp-server" || bareCard.remotes !== undefined) {
        fail(`without IWAC_MCP_PUBLIC_URL the card should have no remotes, got ${JSON.stringify(bareCard.remotes)}`);
      }
    }
  } finally {
    wild.kill("SIGTERM");
  }
}

const failures = reporter.failures();
console.log(`
${failures === 0 ? "ALL HTTP CHECKS PASSED" : `${failures} HTTP CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
