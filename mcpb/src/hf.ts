import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { config, type Subset } from "./config.js";
import {
  buildCacheManifest,
  CACHE_MANIFEST_FILE,
  type CacheManifest,
  parseCacheManifest,
  remoteIdentity,
  remoteSha256,
  type TreeEntry,
} from "./hfCache.js";

class HuggingFaceAccessError extends Error {}

function authHeaders(): HeadersInit | undefined {
  if (!config.privateDataset) return undefined;
  if (!config.hfToken) {
    throw new HuggingFaceAccessError(
      "Private dataset access requires IWAC_HF_TOKEN or HF_TOKEN with read access to the full mirror.",
    );
  }
  return { Authorization: `Bearer ${config.hfToken}` };
}

function checkAccess(res: Response): void {
  if (config.privateDataset && [401, 403, 404].includes(res.status)) {
    throw new HuggingFaceAccessError(
      `Hugging Face private dataset access failed (HTTP ${res.status}). Check that your token has read access to ${config.datasetRepo}.`,
    );
  }
}

async function listTree(subset: Subset): Promise<TreeEntry[]> {
  const url = `https://huggingface.co/api/datasets/${config.datasetRepo}/tree/${config.datasetRevision}/${subset}`;
  const res = await fetch(url, { headers: authHeaders(), signal: AbortSignal.timeout(30_000) });
  checkAccess(res);
  if (!res.ok) {
    throw new Error(`Failed to list ${subset} tree: HTTP ${res.status}`);
  }
  return (await res.json()) as TreeEntry[];
}

async function downloadFile(remotePath: string, destPath: string): Promise<void> {
  const url = `https://huggingface.co/datasets/${config.datasetRepo}/resolve/${config.datasetRevision}/${remotePath}`;
  // Generous timeout: the largest subset is ~185 MB and may run on slow links.
  const res = await fetch(url, { headers: authHeaders(), signal: AbortSignal.timeout(15 * 60_000) });
  checkAccess(res);
  const body = res.body;
  if (!res.ok || !body) {
    throw new Error(`Failed to download ${remotePath}: HTTP ${res.status}`);
  }
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  const tmp = `${destPath}.partial`;
  const fh = await fs.open(tmp, "w");
  try {
    const writer = fh.createWriteStream();
    await new Promise<void>((resolve, reject) => {
      const reader = body.getReader();
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!writer.write(Buffer.from(value))) {
              await new Promise<void>((r) => writer.once("drain", () => r()));
            }
          }
          writer.end(() => resolve());
        } catch (e) {
          writer.destroy();
          reject(e);
        }
      };
      writer.on("error", reject);
      void pump();
    });
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, destPath);
}

async function readCacheManifest(localDir: string): Promise<CacheManifest | undefined> {
  try {
    const raw = JSON.parse(
      await fs.readFile(path.join(localDir, CACHE_MANIFEST_FILE), "utf8"),
    ) as unknown;
    return parseCacheManifest(raw, config.datasetRepo, config.datasetRevision);
  } catch {
    return undefined;
  }
}

async function writeCacheManifest(
  localDir: string,
  entries: TreeEntry[],
  localNames: string[],
): Promise<void> {
  const target = path.join(localDir, CACHE_MANIFEST_FILE);
  const tmp = `${target}.partial`;
  const manifest = buildCacheManifest(
    config.datasetRepo,
    config.datasetRevision,
    entries,
    localNames,
  );
  await fs.writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fs.rename(tmp, target);
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(filePath);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

async function localFileIsCurrent(
  localDir: string,
  name: string,
  entry: TreeEntry,
  manifest: CacheManifest | undefined,
): Promise<boolean> {
  const dest = path.join(localDir, name);
  let size: number;
  try {
    size = (await fs.stat(dest)).size;
  } catch {
    return false;
  }
  if (entry.size !== undefined && size !== entry.size) return false;
  if (entry.size === undefined && size === 0) return false;

  const identity = remoteIdentity(entry);
  if (!identity) return true;

  const cached = manifest?.files[name];
  if (cached?.remotePath === entry.path && cached.identity === identity) return true;

  // Existing installations predate the sidecar. LFS OIDs are content
  // SHA-256 digests, so hash a legacy file once rather than downloading the
  // entire ~250 MB cache again just to establish its identity.
  const expectedSha256 = remoteSha256(entry);
  return expectedSha256 !== undefined && (await sha256File(dest)) === expectedSha256;
}

/**
 * Local file name for a download of `entry`: the Hub name plus a short digest
 * of its content identity, e.g. `train-00000-of-00001.3f9a1c07b2e4.parquet`.
 *
 * A new revision therefore lands BESIDE the file the live view is reading,
 * never on top of it. Replacing in place was safe only while nothing could be
 * reading: on Windows a rename over a file an in-flight query holds open
 * fails, and a multi-shard subset could be read half old, half new. With
 * distinct names the switch is one CREATE OR REPLACE VIEW over the new list
 * (db.ts), and the old file is pruned afterwards. The digest is hashed rather
 * than embedded because identities contain `:`, which Windows forbids in
 * file names. Without an identity there is nothing to tell revisions apart,
 * so the Hub name is kept.
 */
export function downloadName(entry: TreeEntry): string {
  const base = path.basename(entry.path);
  const identity = remoteIdentity(entry);
  if (!identity) return base;
  const tag = createHash("sha256").update(identity).digest("hex").slice(0, 12);
  return base.replace(/(\.parquet)?$/, `.${tag}$1`);
}

/** The local copy of `entry` that is current, if any, trying the name the
 * manifest recorded, the content-named download, then the legacy Hub name. */
async function currentLocalName(
  localDir: string,
  entry: TreeEntry,
  manifest: CacheManifest | undefined,
): Promise<string | undefined> {
  const recorded = Object.entries(manifest?.files ?? {}).find(([, f]) => f.remotePath === entry.path)?.[0];
  const candidates = new Set([recorded, downloadName(entry), path.basename(entry.path)]);
  for (const name of candidates) {
    if (name && (await localFileIsCurrent(localDir, name, entry, manifest))) return name;
  }
  return undefined;
}

/**
 * The cached parquet files for a subset without asking the Hub: the manifest's
 * list when it names files that all exist, otherwise every `*.parquet` in the
 * directory (a cache that predates the manifest, or the offline fixtures).
 */
async function cachedFiles(localDir: string): Promise<string[]> {
  const manifest = await readCacheManifest(localDir);
  const recorded = Object.keys(manifest?.files ?? {});
  if (recorded.length > 0) {
    const present = await Promise.all(
      recorded.map((name) => fs.stat(path.join(localDir, name)).then(() => true, () => false)),
    );
    if (present.every(Boolean)) return recorded.map((name) => path.join(localDir, name));
  }
  try {
    return (await fs.readdir(localDir))
      .filter((name) => name.endsWith(".parquet"))
      .sort()
      .map((name) => path.join(localDir, name));
  } catch {
    return [];
  }
}

export interface SubsetFiles {
  /** Absolute paths of the parquet files that make up the subset now. */
  files: string[];
  /** Whether this call downloaded anything, i.e. the data may have changed. */
  downloaded: boolean;
}

/**
 * Ensure the current parquet files for a subset are present locally and return
 * them. Files a newer revision replaced are left in place: the view may still
 * be reading them, so removing them is pruneSubset's job, once the view no
 * longer points at them.
 */
export async function ensureSubset(subset: Subset): Promise<SubsetFiles> {
  const localDir = path.join(config.cacheDir, subset);
  await fs.mkdir(localDir, { recursive: true });

  // Offline mode: trust the cache as-is, no metadata refresh, no pruning.
  if (config.offline) {
    const files = await cachedFiles(localDir);
    if (files.length > 0) return { files, downloaded: false };
    throw new Error(
      `IWAC_OFFLINE is set but there are no cached parquet files for ${subset} in ${localDir}`,
    );
  }

  let tree: TreeEntry[];
  try {
    tree = await listTree(subset);
  } catch (err) {
    if (err instanceof HuggingFaceAccessError) throw err;
    const files = await cachedFiles(localDir);
    if (files.length > 0) {
      console.error(
        `[iwac] warning: failed to refresh Hugging Face metadata for ${subset}; using cached parquet files in ${localDir}. ` +
          `Freshness could not be verified. ${(err as Error).message}`,
      );
      return { files, downloaded: false };
    }
    throw err;
  }
  const parquetFiles = tree.filter(
    (e) => e.type === "file" && e.path.endsWith(".parquet"),
  );
  if (parquetFiles.length === 0) {
    throw new Error(`No parquet files found for subset ${subset}`);
  }

  const manifest = await readCacheManifest(localDir);
  const names: string[] = [];
  let downloaded = false;
  for (const entry of parquetFiles) {
    const current = await currentLocalName(localDir, entry, manifest);
    if (current) {
      names.push(current);
      continue;
    }
    const name = downloadName(entry);
    const dest = path.join(localDir, name);
    console.error(`[iwac] downloading ${entry.path} -> ${dest}`);
    await downloadFile(entry.path, dest);
    names.push(name);
    downloaded = true;
  }

  // Persist only after every download succeeds. If a refresh is interrupted,
  // the previous identities remain and force a safe retry.
  await writeCacheManifest(localDir, parquetFiles, names);

  return { files: names.map((name) => path.join(localDir, name)), downloaded };
}

/**
 * Delete the parquet files of a subset that are not in `keep`, plus `.partial`
 * leftovers from interrupted downloads. Call it only once nothing reads the
 * other files any more, i.e. after the view points at `keep`.
 *
 * Disk hygiene, not correctness: the view reads an explicit file list, so a
 * stale shard left behind (a repartitioned revision, say) is never unioned in.
 * That is also why a failed delete is only logged. On Windows a query still
 * finishing on the old file holds it open, and the next prune retries.
 */
export async function pruneSubset(subset: Subset, keep: string[]): Promise<void> {
  if (config.offline) return;
  const localDir = path.join(config.cacheDir, subset);
  const wanted = new Set(keep.map((file) => path.basename(file)));
  let names: string[];
  try {
    names = await fs.readdir(localDir);
  } catch {
    return;
  }
  for (const name of names) {
    const stale = (name.endsWith(".parquet") && !wanted.has(name)) || name.endsWith(".partial");
    if (!stale) continue;
    try {
      await fs.rm(path.join(localDir, name), { force: true });
      console.error(`[iwac] pruned stale cache file ${subset}/${name}`);
    } catch (err) {
      console.error(`[iwac] could not prune ${subset}/${name} yet: ${(err as Error).message}`);
    }
  }
}

/** A DuckDB `read_parquet` list literal for these files. Forward slashes work
 * on Windows for DuckDB. */
export function parquetList(files: string[]): string {
  return `[${files.map((file) => `'${file.replaceAll("\\", "/").replace(/'/g, "''")}'`).join(", ")}]`;
}
