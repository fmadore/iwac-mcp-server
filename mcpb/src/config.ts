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

export const config = {
  datasetRepo: DATASET_REPO,
  datasetRevision: DATASET_REVISION,
  cacheDir: resolveCacheDir(),
  semanticSearchEnabled: parseBool(process.env.IWAC_SEMANTIC_SEARCH_ENABLED, false),
  embeddingModel: process.env.IWAC_EMBEDDING_MODEL?.trim() || "gemini-embedding-2",
  embeddingDimensionality: Number.parseInt(
    process.env.IWAC_EMBEDDING_DIMENSIONALITY || "768",
    10,
  ),
  googleApiKey:
    process.env.IWAC_GOOGLE_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim() ||
    process.env.GEMINI_API_KEY?.trim() ||
    undefined,
};
