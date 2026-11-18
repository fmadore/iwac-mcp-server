// The MCP Server Card (SEP-2127) as a pure value: schema conformance, the
// public-URL rule, ETag matching, agreement with the Registry entry, and the
// promise that nothing operational leaks into a document served without a
// token. test/http-server.test.mjs covers the route itself (headers, 304,
// methods) and checks the protocol list against the live `server/discover`.
//
// The schema rules below are transcribed from schema.ts of
// github.com/modelcontextprotocol/ext-server-card (v1, commit 526201bb): the
// required members, the patterns and the length limits. Validating against the
// published schema.json would need the network or a vendored copy that drifts
// just as silently, so the constraints are named here, next to their source.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server";
import {
  buildServerCard,
  etagMatches,
  PROTOCOL_VERSIONS,
  parsePublicUrl,
  REGISTRY_NAME,
  SERVER_CARD_SCHEMA_URL,
  type ServerCard,
  serveableServerCard,
  serverCardFromEnv,
} from "../src/serverCard.js";
import { at, must } from "./_must.js";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const registryScript = readFileSync(new URL("../scripts/make-server-json.mjs", import.meta.url), "utf8");

/** Top-level members the v1 ServerCard interface defines. */
const SCHEMA_MEMBERS = new Set([
  "$schema", "name", "version", "description", "title", "websiteUrl", "repository", "icons", "remotes", "_meta",
]);
const REMOTE_MEMBERS = new Set(["type", "url", "headers", "variables", "supportedProtocolVersions"]);

/** The v1 constraints a card must meet; returns the first violation or null. */
function schemaViolation(card: ServerCard): string | null {
  const record = card as unknown as Record<string, unknown>;
  for (const key of ["$schema", "name", "version", "description"]) {
    if (typeof record[key] !== "string") return `missing required ${key}`;
  }
  for (const key of Object.keys(record)) if (!SCHEMA_MEMBERS.has(key)) return `unknown member ${key}`;
  if (!/^https:\/\/static\.modelcontextprotocol\.io\/schemas\/v1\/server-card\.schema\.json$/.test(card.$schema)) {
    return `bad $schema ${card.$schema}`;
  }
  if (card.name.length < 3 || card.name.length > 200 || !/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/.test(card.name)) {
    return `bad name ${card.name}`;
  }
  if (card.version.length > 255 || /^[\^~><=]|\.x$|\*/.test(card.version)) return `bad version ${card.version}`;
  if (card.description.length < 1 || card.description.length > 100) return `description is ${card.description.length} chars`;
  if (card.title !== undefined && (card.title.length < 1 || card.title.length > 100)) return "bad title length";
  for (const url of [card.websiteUrl, card.repository?.url, ...(card.icons ?? []).map((icon) => icon.src)]) {
    if (url !== undefined && !URL.canParse(url)) return `not a URI: ${url}`;
  }
  if (card.repository && typeof card.repository.source !== "string") return "repository.source missing";
  for (const remote of card.remotes ?? []) {
    for (const key of Object.keys(remote)) if (!REMOTE_MEMBERS.has(key)) return `unknown remote member ${key}`;
    if (remote.type !== "streamable-http" && remote.type !== "sse") return `bad remote type ${remote.type}`;
    if (!/^(https?:\/\/[^\s]+|\{[a-zA-Z_][a-zA-Z0-9_]*\}[^\s]*)$/.test(remote.url)) return `bad remote url ${remote.url}`;
  }
  return null;
}

describe("server card shape", () => {
  it("meets the v1 schema without a public URL, and then has no remotes", () => {
    const card = buildServerCard({ version: "6.1.0" });
    assert.equal(schemaViolation(card), null);
    assert.equal(card.remotes, undefined, "a relative or guessed remote URL is not allowed");
    assert.equal(card.$schema, SERVER_CARD_SCHEMA_URL);
    assert.equal(card.version, "6.1.0");
  });

  it("meets the v1 schema with a public URL and advertises one Streamable HTTP remote", () => {
    const card = buildServerCard({ version: "6.1.0", publicUrl: "https://islam.zmo.de/mcp" });
    assert.equal(schemaViolation(card), null);
    const remotes = must(card.remotes, "remotes");
    assert.equal(remotes.length, 1);
    const remote = at(remotes, 0);
    assert.equal(remote.type, "streamable-http");
    assert.equal(remote.url, "https://islam.zmo.de/mcp");
    assert.deepEqual(remote.supportedProtocolVersions, [...PROTOCOL_VERSIONS]);
  });

  it("lists the modern era first and every 2025-era version the SDK accepts", () => {
    assert.equal(PROTOCOL_VERSIONS[0], "2026-07-28");
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) assert.ok(PROTOCOL_VERSIONS.includes(version), version);
    assert.equal(new Set(PROTOCOL_VERSIONS).size, PROTOCOL_VERSIONS.length, "no duplicates");
  });

  it("carries the Registry identity and the manifest's descriptive fields", () => {
    const card = buildServerCard({ version: "1.2.3" });
    // make-server-json.mjs cannot import TypeScript, so read its literals.
    const literal = (pattern: RegExp, what: string) => must(pattern.exec(registryScript)?.[1], what);
    assert.equal(REGISTRY_NAME, literal(/name: "([^"]+)"/, "registry name"));
    assert.equal(card.repository?.url, literal(/const REPO_URL = "([^"]+)"/, "REPO_URL"));
    assert.equal(at(must(card.icons, "icons"), 0).src, literal(/src: "([^"]+)"/, "icon src"));
    assert.equal(card.title, manifest.display_name);
    assert.equal(card.description, manifest.description);
    assert.equal(card.websiteUrl, manifest.homepage);
  });

  it("never names the mirror, the token or anything else operational", () => {
    const body = serveableServerCard(buildServerCard({ version: "1.0.0", publicUrl: "https://example.org/mcp" })).body;
    for (const secret of [
      "islam-west-africa-collection", "huggingface", "hf.co", "token", "bearer", "cache", "IWAC_", "private",
      "/run/secrets", "duckdb", "profile", "tools", "capabilities", "prompts",
    ]) {
      assert.ok(!body.toLowerCase().includes(secret.toLowerCase()), `card mentions ${secret}`);
    }
  });
});

describe("IWAC_MCP_PUBLIC_URL", () => {
  it("accepts absolute http(s) URLs and drops one trailing slash after a path", () => {
    assert.deepEqual(parsePublicUrl(undefined), {});
    assert.deepEqual(parsePublicUrl("https://islam.zmo.de/mcp"), { url: "https://islam.zmo.de/mcp" });
    assert.deepEqual(parsePublicUrl("https://islam.zmo.de/mcp/"), { url: "https://islam.zmo.de/mcp" });
    assert.deepEqual(parsePublicUrl("http://localhost:8000/mcp"), { url: "http://localhost:8000/mcp" });
    assert.deepEqual(parsePublicUrl("https://mcp.example.org"), { url: "https://mcp.example.org/" });
  });

  it("refuses values that would publish credentials, queries or a non-HTTP endpoint", () => {
    for (const raw of [
      "/mcp", "islam.zmo.de/mcp", "ftp://islam.zmo.de/mcp", "https://user:pw@islam.zmo.de/mcp",
      "https://islam.zmo.de/mcp?token=x", "https://islam.zmo.de/mcp#x", "https://{tenant}.example/mcp",
    ]) {
      assert.deepEqual(parsePublicUrl(raw), { invalid: raw }, raw);
    }
  });

  it("feeds the process card through envString, which ignores blanks and templates", () => {
    const saved = process.env.IWAC_MCP_PUBLIC_URL;
    try {
      // The last is an unexpanded launcher template, built so it reads as one.
      for (const unset of ["", "  ", `$${"{"}user_config.public_url}`]) {
        process.env.IWAC_MCP_PUBLIC_URL = unset;
        const result = serverCardFromEnv();
        assert.equal(result.invalidPublicUrl, undefined, unset);
        assert.equal(result.served.card.remotes, undefined, unset);
      }
      process.env.IWAC_MCP_PUBLIC_URL = "https://islam.zmo.de/mcp/";
      assert.equal(at(must(serverCardFromEnv().served.card.remotes, "remotes"), 0).url, "https://islam.zmo.de/mcp");
      process.env.IWAC_MCP_PUBLIC_URL = "not a url";
      assert.equal(serverCardFromEnv().invalidPublicUrl, "not a url");
    } finally {
      if (saved === undefined) delete process.env.IWAC_MCP_PUBLIC_URL;
      else process.env.IWAC_MCP_PUBLIC_URL = saved;
    }
  });
});

describe("entity tag", () => {
  const { body, etag } = serveableServerCard(buildServerCard({ version: "1.0.0" }));

  it("is a quoted strong validator that changes with the bytes", () => {
    assert.match(etag, /^"[A-Za-z0-9_-]+"$/);
    assert.ok(body.length > 0);
    assert.notEqual(serveableServerCard(buildServerCard({ version: "1.0.1" })).etag, etag);
  });

  it("matches If-None-Match lists, weak forms and *", () => {
    assert.ok(etagMatches(etag, etag));
    assert.ok(etagMatches(`W/${etag}`, etag));
    assert.ok(etagMatches(`"other", ${etag}`, etag));
    assert.ok(etagMatches("*", etag));
    assert.ok(!etagMatches(undefined, etag));
    assert.ok(!etagMatches('"other"', etag));
  });
});
