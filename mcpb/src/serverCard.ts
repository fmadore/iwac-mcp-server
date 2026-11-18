// MCP Server Card (SEP-2127, an optional Extensions Track extension): a static,
// public JSON document a client can read BEFORE connecting, to learn who this
// server is and where and how to connect. Normative source: `schema.ts` and
// `docs/discovery.md` of github.com/modelcontextprotocol/ext-server-card
// (formerly experimental-ext-server-card), v1 schema, commit 526201bb.
//
// What it deliberately does NOT carry: tools, prompts, resources, capabilities
// or extension support (the spec leaves those to live negotiation, since they
// vary by client and deployment), and nothing operational. The card is
// served without the bearer check to anyone who asks, so it must never name
// the dataset mirror, the token, cache paths, tool profile or any other
// setting of this process. Every field below is either a build-time constant
// or the operator's own public URL.
//
// Every value comes from a source that already exists, so the card cannot
// drift from what the server reports elsewhere:
// - identity (name, repository, icon) matches the MCP Registry entry that
//   scripts/make-server-json.mjs generates (test/server-card.test.ts compares
//   them, since that script cannot import TypeScript);
// - title, description and website come from manifest.json, as they do there;
// - version is the build-time `__IWAC_VERSION__`, as in the MCP handshake;
// - protocol versions are the SDK's own lists (see PROTOCOL_VERSIONS).
import { createHash } from "node:crypto";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server";
// esbuild inlines the JSON at build time, so the shipped server (and the
// Docker image, which has no manifest.json) reads nothing from disk. No import
// attribute: tsconfig's `module: Node16` rejects them, and tsx and esbuild
// both resolve JSON without one.
import manifest from "../manifest.json";
import { envString } from "./config.js";

// Injected by esbuild (scripts/bundle.mjs) from package.json, as in index.ts.
declare const __IWAC_VERSION__: string;
const VERSION = typeof __IWAC_VERSION__ === "string" ? __IWAC_VERSION__ : "0.0.0-dev";

/** The only `$schema` value the v1 schema accepts (a pattern, not a default). */
export const SERVER_CARD_SCHEMA_URL = "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";

/** Media type the card is served as (docs/discovery.md, "MCP Server Cards"). */
export const SERVER_CARD_MEDIA_TYPE = "application/mcp-server-card+json";

/** `<streamable-http-url>/server-card`, the location the spec reserves. The
 * app serves the transport at /mcp, so this is the path behind any proxy that
 * mounts it unchanged (nginx on islam.zmo.de does). */
export const SERVER_CARD_PATH = "/mcp/server-card";

/** Registry identity, kept equal to scripts/make-server-json.mjs. */
export const REGISTRY_NAME = "io.github.fmadore/iwac-mcp-server";
const REPOSITORY_URL = "https://github.com/fmadore/iwac-mcp-server";
const ICON_SRC = "https://raw.githubusercontent.com/fmadore/iwac-mcp-server/main/mcpb/icon.png";

/**
 * Protocol revisions the HTTP endpoint answers, newest first.
 *
 * The 2025-era list is the SDK's exported `SUPPORTED_PROTOCOL_VERSIONS`, the
 * versions `initialize` accepts. The 2026-07-28 era is negotiated through
 * `server/discover`, whose list (`SUPPORTED_MODERN_PROTOCOL_VERSIONS`, which
 * `createMcpHandler` installs) the SDK 2.4 keeps internal: there is no public
 * export to read it from. It is therefore named here once, and
 * test/http-server.test.mjs checks it against what the running endpoint's
 * `server/discover` actually returns, which is the value the spec tells
 * clients to prefer when the two disagree.
 */
const MODERN_PROTOCOL_VERSIONS = ["2026-07-28"] as const;
export const PROTOCOL_VERSIONS: readonly string[] = [...MODERN_PROTOCOL_VERSIONS, ...SUPPORTED_PROTOCOL_VERSIONS];

/** The subset of the v1 `ServerCard` shape this server fills. Field names and
 * nesting are the schema's; nothing here is an invention. */
export interface ServerCard {
  $schema: string;
  name: string;
  version: string;
  description: string;
  title?: string;
  websiteUrl?: string;
  repository?: { url: string; source: string };
  icons?: Array<{ src: string; mimeType?: string }>;
  remotes?: Array<{ type: "streamable-http"; url: string; supportedProtocolVersions?: string[] }>;
}

export interface PublicUrl {
  /** The normalised URL, when the variable is set and valid. */
  url?: string;
  /** The raw value, when the variable is set but unusable. */
  invalid?: string;
}

/**
 * Parse IWAC_MCP_PUBLIC_URL, the Streamable HTTP URL clients reach this server
 * at (behind nginx: https://islam.zmo.de/mcp). The process cannot work that
 * out itself: it sees nginx's Host and an internal port, not the public
 * scheme, host and mount. The checks mirror parseAllowedOrigins in config.ts:
 * an absolute http(s) URL with no credentials, query or fragment, since any of
 * those would be published verbatim to every visitor. The path is kept
 * (it is the mount point), with one trailing slash dropped so the card and
 * its own location read the same way.
 */
export function parsePublicUrl(raw: string | undefined): PublicUrl {
  if (raw === undefined) return {};
  try {
    const url = new URL(raw);
    const valid =
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !raw.includes("{");
    if (!valid) return { invalid: raw };
    const href = url.href;
    return { url: url.pathname !== "/" && href.endsWith("/") ? href.slice(0, -1) : href };
  } catch {
    return { invalid: raw };
  }
}

/**
 * Build the card. `remotes` is present only when the public URL is known: the
 * schema requires an absolute `http(s)://` (or templated) URL there, so a
 * relative `/mcp` is not allowed, and a guessed host would be worse than none.
 * Without it the card still identifies the server, and the protocol versions
 * (a `remotes[]` member in the schema) are left out with it.
 */
export function buildServerCard(options: { version: string; publicUrl?: string }): ServerCard {
  const card: ServerCard = {
    $schema: SERVER_CARD_SCHEMA_URL,
    name: REGISTRY_NAME,
    version: options.version,
    description: manifest.description,
    title: manifest.display_name,
    websiteUrl: manifest.homepage,
    repository: { url: REPOSITORY_URL, source: "github" },
    icons: [{ src: ICON_SRC, mimeType: "image/png" }],
  };
  if (options.publicUrl !== undefined) {
    card.remotes = [
      { type: "streamable-http", url: options.publicUrl, supportedProtocolVersions: [...PROTOCOL_VERSIONS] },
    ];
  }
  return card;
}

/** The card as served: its bytes and their entity tag, computed once. */
export interface ServedServerCard {
  card: ServerCard;
  body: string;
  /** Strong validator over the exact bytes, quoted as HTTP requires. */
  etag: string;
}

export function serveableServerCard(card: ServerCard): ServedServerCard {
  const body = JSON.stringify(card);
  const etag = `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
  return { card, body, etag };
}

/** The process's card, from the build version and IWAC_MCP_PUBLIC_URL. The
 * caller decides what an invalid URL means (http.ts refuses to start). */
export function serverCardFromEnv(): { served: ServedServerCard; invalidPublicUrl?: string } {
  const publicUrl = parsePublicUrl(envString("IWAC_MCP_PUBLIC_URL"));
  const served = serveableServerCard(buildServerCard({ version: VERSION, publicUrl: publicUrl.url }));
  return publicUrl.invalid === undefined ? { served } : { served, invalidPublicUrl: publicUrl.invalid };
}

/** True when an If-None-Match header names this entity tag (or `*`). Weak
 * comparison, as RFC 9110 prescribes for If-None-Match on GET and HEAD. */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const bare = etag.replace(/^W\//, "");
  return header.split(",").some((candidate) => {
    const tag = candidate.trim();
    return tag === "*" || tag.replace(/^W\//, "") === bare;
  });
}
