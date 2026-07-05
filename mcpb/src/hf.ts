import * as fs from "node:fs/promises";
import * as path from "node:path";
import { config, type Subset } from "./config.js";

interface TreeEntry {
  type: "file" | "directory";
  path: string;
  size?: number;
}

async function listTree(subset: Subset): Promise<TreeEntry[]> {
  const url = `https://huggingface.co/api/datasets/${config.datasetRepo}/tree/${config.datasetRevision}/${subset}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    throw new Error(`Failed to list ${subset} tree: HTTP ${res.status}`);
  }
  return (await res.json()) as TreeEntry[];
}

async function downloadFile(remotePath: string, destPath: string): Promise<void> {
  const url = `https://huggingface.co/datasets/${config.datasetRepo}/resolve/${config.datasetRevision}/${remotePath}`;
  // Generous timeout: the largest subset is ~185 MB and may run on slow links.
  const res = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ${remotePath}: HTTP ${res.status}`);
  }
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  const tmp = destPath + ".partial";
  const fh = await fs.open(tmp, "w");
  try {
    const writer = fh.createWriteStream();
    await new Promise<void>((resolve, reject) => {
      const reader = res.body!.getReader();
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

async function hasLocalParquet(localDir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(localDir);
    return entries.some((name) => name.endsWith(".parquet"));
  } catch {
    return false;
  }
}

/**
 * Ensure the parquet files for a subset are present locally.
 * Returns the local directory containing `train-*.parquet` files.
 */
export async function ensureSubset(subset: Subset): Promise<string> {
  const localDir = path.join(config.cacheDir, subset);
  await fs.mkdir(localDir, { recursive: true });

  // Offline mode: trust the cache as-is, no metadata refresh, no pruning.
  if (config.offline) {
    if (await hasLocalParquet(localDir)) return localDir;
    throw new Error(
      `IWAC_OFFLINE is set but there are no cached parquet files for ${subset} in ${localDir}`,
    );
  }

  let tree: TreeEntry[];
  try {
    tree = await listTree(subset);
  } catch (err) {
    if (await hasLocalParquet(localDir)) {
      console.error(
        `[iwac] warning: failed to refresh Hugging Face metadata for ${subset}; using cached parquet files in ${localDir}. ` +
          `Freshness could not be verified. ${(err as Error).message}`,
      );
      return localDir;
    }
    throw err;
  }
  const parquetFiles = tree.filter(
    (e) => e.type === "file" && e.path.endsWith(".parquet"),
  );
  if (parquetFiles.length === 0) {
    throw new Error(`No parquet files found for subset ${subset}`);
  }

  for (const entry of parquetFiles) {
    const fileName = path.basename(entry.path);
    const dest = path.join(localDir, fileName);
    try {
      const stat = await fs.stat(dest);
      if (entry.size !== undefined && stat.size === entry.size) continue;
      if (entry.size === undefined && stat.size > 0) continue;
    } catch {
      /* file missing, will download */
    }
    console.error(`[iwac] downloading ${entry.path} -> ${dest}`);
    await downloadFile(entry.path, dest);
  }

  // Prune local files the current revision no longer lists. Without this, a
  // repartitioned dataset (train-00000-of-00002 -> train-00000-of-00001) leaves
  // the stale shard behind and the *.parquet view glob silently unions old and
  // new rows. Also sweeps .partial leftovers from interrupted downloads.
  const wanted = new Set(parquetFiles.map((e) => path.basename(e.path)));
  for (const name of await fs.readdir(localDir)) {
    const stale =
      (name.endsWith(".parquet") && !wanted.has(name)) || name.endsWith(".partial");
    if (stale) {
      console.error(`[iwac] pruning stale cache file ${subset}/${name}`);
      await fs.rm(path.join(localDir, name), { force: true });
    }
  }

  return localDir;
}

/**
 * DuckDB-friendly glob pattern for a subset's parquet files.
 * Forward slashes work on Windows for DuckDB.
 */
export function subsetGlob(localDir: string): string {
  return path.join(localDir, "*.parquet").replaceAll("\\", "/");
}
