import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DATASET_REPO = "fmadore/islam-west-africa-collection";
export const PRIVATE_DATASET_REPO = `${DATASET_REPO}-full`;
export const DATASET_REVISION = "main";

export type Subset = "articles" | "publications" | "documents" | "audiovisual" | "images" | "index" | "references";

export const ALL_SUBSETS: Subset[] = [
  "articles",
  "publications",
  "documents",
  "audiovisual",
  "images",
  "index",
  "references",
];

/**
 * A trimmed environment value, or undefined when it is unset, blank, or an
 * unexpanded launcher template. The extension loader substitutes
 * `${user_config.x}` only for settings that have a value or a default, so an
 * optional setting the user left empty (the Hugging Face token, the Google key)
 * reaches this process as that literal string. It is truthy: as a token it
 * earned a misleading 401 and, read first, it hid a valid `HF_TOKEN` or
 * `GOOGLE_API_KEY` from the environment. A manifest default such as
 * "${HOME}/.iwac-mcp/cache" can arrive unexpanded the same way.
 */
export function envString(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v && !v.includes("${") ? v : undefined;
}

function resolveCacheDir(): string {
  // path.resolve() would turn an unexpanded "${HOME}/..." into
  // "<cwd>/${HOME}/..." and crash with EPERM when cwd is a protected dir (e.g.
  // C:\Windows\system32); envString drops it, and we fall back to $HOME.
  const raw = envString("IWAC_CACHE_DIR");
  return raw ? path.resolve(raw) : path.join(os.homedir(), ".iwac-mcp", "cache");
}

function parseBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off", ""].includes(s)) return false;
  return fallback;
}

/** Parse a decimal positive-integer env var. `parseInt()` is deliberately not
 * used: it accepts malformed prefixes such as `8000junk` and truncates `3.5`
 * to 3, contradicting the configuration contract. */
export function parsePositiveInt(v: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = v?.trim() ?? "";
  if (!/^\d+$/.test(raw)) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 && n <= max ? n : fallback;
}

/** Hours between background checks for a newer dataset revision. `0` turns
 * them off; anything else that is not a positive whole number falls back to
 * the default rather than silently disabling the refresh. */
export function parseRefreshHours(v: string | undefined, fallback = 24): number {
  return v?.trim() === "0" ? 0 : parsePositiveInt(v, fallback, 24 * 365);
}

export interface ParsedOrigins {
  allowed: ReadonlySet<string>;
  invalid: string[];
}

/** Parse the exact HTTP(S) origins allowed to reach the MCP endpoint.
 * Paths, credentials, queries, fragments, opaque origins, and wildcard values
 * are rejected: accepting any of them would turn the allowlist into a false
 * sense of DNS-rebinding protection. */
export function parseAllowedOrigins(v: string | undefined): ParsedOrigins {
  const allowed = new Set<string>();
  const invalid: string[] = [];
  for (const raw of v?.split(",") ?? []) {
    const candidate = raw.trim();
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      const valid =
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.origin !== "null" &&
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash;
      if (valid) allowed.add(url.origin);
      else invalid.push(candidate);
    } catch {
      invalid.push(candidate);
    }
  }
  return { allowed, invalid };
}

/**
 * Bearer token for the remote HTTP transport. Prefer a mounted secret file
 * (Docker/production convention: /run/secrets/iwac_mcp_token), falling back to
 * an env var for local dev. Returns undefined when neither is set — stdio mode
 * (Claude Desktop) never needs it, and the HTTP server refuses to start without it.
 */
function readBearerToken(): string | undefined {
  const file = envString("IWAC_MCP_TOKEN_FILE") ?? "/run/secrets/iwac_mcp_token";
  try {
    const v = fs.readFileSync(file, "utf8").trim();
    if (v) return v;
  } catch {
    // file absent/unreadable — fall through to the env var
  }
  return envString("IWAC_MCP_BEARER_TOKEN");
}

const httpOrigins = parseAllowedOrigins(envString("IWAC_MCP_ALLOWED_ORIGINS"));
const privateDataset = parseBool(envString("IWAC_PRIVATE_DATASET"), false);

export function datasetCacheDir(base: string, usePrivate: boolean): string {
  return usePrivate ? path.join(base, "private-full") : base;
}

export const config = {
  datasetRepo: privateDataset ? PRIVATE_DATASET_REPO : DATASET_REPO,
  privateDataset,
  hfToken: envString("IWAC_HF_TOKEN") ?? envString("HF_TOKEN"),
  datasetRevision: envString("IWAC_DATASET_REVISION") ?? DATASET_REVISION,
  cacheDir: datasetCacheDir(resolveCacheDir(), privateDataset),
  // Offline mode: trust whatever parquet is cached, never touch the network.
  // Used by the hermetic fixture tests and useful on flaky links.
  offline: parseBool(envString("IWAC_OFFLINE"), false),
  // How long a loaded subset is trusted before the next tool call that touches
  // it checks the Hub for a newer revision in the background (db.ts). A
  // long-running server (the HTTP endpoint, a desktop session left open)
  // otherwise serves the data it started with until it is restarted.
  refreshIntervalMs: parseRefreshHours(envString("IWAC_REFRESH_HOURS")) * 3_600_000,
  semanticSearchEnabled: parseBool(envString("IWAC_SEMANTIC_SEARCH_ENABLED"), false),
  embeddingProvider: envString("IWAC_EMBEDDING_PROVIDER") === "local" ? "local" : "gemini",
  localEmbeddingUrl: envString("IWAC_LOCAL_EMBEDDING_URL") ?? "http://127.0.0.1:8080/v1/embeddings",
  localEmbeddingApiKey: envString("IWAC_LOCAL_EMBEDDING_API_KEY"),
  embeddingModel: envString("IWAC_EMBEDDING_MODEL") ?? "gemini-embedding-2",
  embeddingDimensionality: parsePositiveInt(envString("IWAC_EMBEDDING_DIMENSIONALITY"), 768),
  googleApiKey:
    envString("IWAC_GOOGLE_API_KEY") ?? envString("GOOGLE_API_KEY") ?? envString("GEMINI_API_KEY"),
  // Remote HTTP transport (node server/index.js --http). Unused by stdio mode.
  httpPort: parsePositiveInt(envString("PORT"), 8000, 65_535),
  // The private mirror holds restricted full text. HTTP mode is how the shared
  // public endpoint runs, so serving the mirror over it takes a second,
  // explicit opt-in rather than one stray variable in a compose file.
  allowPrivateHttp: parseBool(envString("IWAC_ALLOW_PRIVATE_HTTP"), false),
  bearerToken: readBearerToken(),
  httpAllowedOrigins: httpOrigins.allowed,
  invalidHttpOrigins: httpOrigins.invalid,
};
