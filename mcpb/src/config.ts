import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DATASET_REPO = "fmadore/islam-west-africa-collection";
export const DATASET_REVISION = "main";

export type Subset =
  | "articles"
  | "publications"
  | "documents"
  | "audiovisual"
  | "images"
  | "index"
  | "references";

export const ALL_SUBSETS: Subset[] = [
  "articles",
  "publications",
  "documents",
  "audiovisual",
  "images",
  "index",
  "references",
];

function resolveCacheDir(): string {
  const raw = process.env.IWAC_CACHE_DIR?.trim();
  // Ignore an unexpanded launcher template (e.g. a manifest default of
  // "${HOME}/.iwac-mcp/cache" passed through literally). path.resolve() would
  // otherwise turn "${HOME}/..." into "<cwd>/${HOME}/..." and crash with EPERM
  // when cwd is a protected dir (e.g. C:\Windows\system32). Fall back to $HOME.
  if (raw && raw.length > 0 && !raw.includes("${")) return path.resolve(raw);
  return path.join(os.homedir(), ".iwac-mcp", "cache");
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
export function parsePositiveInt(
  v: string | undefined,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const raw = v?.trim() ?? "";
  if (!/^\d+$/.test(raw)) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 && n <= max ? n : fallback;
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
  const file = process.env.IWAC_MCP_TOKEN_FILE?.trim() || "/run/secrets/iwac_mcp_token";
  try {
    const v = fs.readFileSync(file, "utf8").trim();
    if (v) return v;
  } catch {
    // file absent/unreadable — fall through to the env var
  }
  return process.env.IWAC_MCP_BEARER_TOKEN?.trim() || undefined;
}

const httpOrigins = parseAllowedOrigins(process.env.IWAC_MCP_ALLOWED_ORIGINS);

export const config = {
  datasetRepo: DATASET_REPO,
  datasetRevision: DATASET_REVISION,
  cacheDir: resolveCacheDir(),
  // Offline mode: trust whatever parquet is cached, never touch the network.
  // Used by the hermetic fixture tests and useful on flaky links.
  offline: parseBool(process.env.IWAC_OFFLINE, false),
  semanticSearchEnabled: parseBool(process.env.IWAC_SEMANTIC_SEARCH_ENABLED, false),
  embeddingModel: process.env.IWAC_EMBEDDING_MODEL?.trim() || "gemini-embedding-2",
  embeddingDimensionality: parsePositiveInt(process.env.IWAC_EMBEDDING_DIMENSIONALITY, 768),
  googleApiKey:
    process.env.IWAC_GOOGLE_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim() ||
    process.env.GEMINI_API_KEY?.trim() ||
    undefined,
  // Remote HTTP transport (node server/index.js --http). Unused by stdio mode.
  httpPort: parsePositiveInt(process.env.PORT, 8000, 65_535),
  bearerToken: readBearerToken(),
  httpAllowedOrigins: httpOrigins.allowed,
  invalidHttpOrigins: httpOrigins.invalid,
};
