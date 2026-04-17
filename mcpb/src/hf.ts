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
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to list ${subset} tree: HTTP ${res.status}`);
  }
  return (await res.json()) as TreeEntry[];
}

async function downloadFile(remotePath: string, destPath: string): Promise<void> {
  const url = `https://huggingface.co/datasets/${config.datasetRepo}/resolve/${config.datasetRevision}/${remotePath}`;
  const res = await fetch(url);
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

/**
 * Ensure the parquet files for a subset are present locally.
 * Returns the local directory containing `train-*.parquet` files.
 */
export async function ensureSubset(subset: Subset): Promise<string> {
  const localDir = path.join(config.cacheDir, subset);
  await fs.mkdir(localDir, { recursive: true });

  const tree = await listTree(subset);
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

  return localDir;
}

/**
 * DuckDB-friendly glob pattern for a subset's parquet files.
 * Forward slashes work on Windows for DuckDB.
 */
export function subsetGlob(localDir: string): string {
  return path.join(localDir, "*.parquet").replaceAll("\\", "/");
}
