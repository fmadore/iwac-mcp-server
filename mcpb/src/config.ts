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
  | "index"
  | "references";

export const ALL_SUBSETS: Subset[] = [
  "articles",
  "publications",
  "documents",
  "audiovisual",
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

/** Parse a positive integer env var, falling back on garbage/NaN/≤0 instead of
 * letting a NaN leak into an API call or `listen()`. */
function parsePositiveInt(v: string | undefined, fallback: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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
  httpPort: parsePositiveInt(process.env.PORT, 8000),
  bearerToken: readBearerToken(),
};
