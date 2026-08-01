import * as path from "node:path";

export const CACHE_MANIFEST_FILE = ".iwac-cache-metadata.json";

/** The fields returned by the Hub dataset-tree API that identify file content. */
export interface TreeEntry {
  type: "file" | "directory";
  path: string;
  size?: number;
  oid?: string;
  lfs?: {
    oid?: string;
    sha256?: string;
  };
  xetHash?: string;
}

export interface CachedFileMetadata {
  remotePath: string;
  size?: number;
  identity?: string;
}

export interface CacheManifest {
  schemaVersion: 1;
  datasetRepo: string;
  datasetRevision: string;
  files: Record<string, CachedFileMetadata>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Prefer the LFS content SHA-256, then Xet's content hash, then the Git blob
 * OID. All three change when a same-sized file is republished on the Hub.
 */
export function remoteIdentity(entry: TreeEntry): string | undefined {
  const lfsOid = entry.lfs?.oid ?? entry.lfs?.sha256;
  if (lfsOid) return `lfs:${lfsOid.toLowerCase()}`;
  if (entry.xetHash) return `xet:${entry.xetHash.toLowerCase()}`;
  if (entry.oid) return `git:${entry.oid.toLowerCase()}`;
  return undefined;
}

/** Return the LFS content digest when the API supplied a valid SHA-256. */
export function remoteSha256(entry: TreeEntry): string | undefined {
  const oid = entry.lfs?.oid ?? entry.lfs?.sha256;
  return oid && /^[a-f\d]{64}$/i.test(oid) ? oid.toLowerCase() : undefined;
}

export function buildCacheManifest(
  datasetRepo: string,
  datasetRevision: string,
  entries: TreeEntry[],
): CacheManifest {
  const files: Record<string, CachedFileMetadata> = {};
  for (const entry of entries) {
    const identity = remoteIdentity(entry);
    files[path.basename(entry.path)] = {
      remotePath: entry.path,
      ...(entry.size === undefined ? {} : { size: entry.size }),
      ...(identity === undefined ? {} : { identity }),
    };
  }
  return { schemaVersion: 1, datasetRepo, datasetRevision, files };
}

/** Ignore stale or malformed sidecars instead of trusting partial metadata. */
export function parseCacheManifest(
  value: unknown,
  datasetRepo: string,
  datasetRevision: string,
): CacheManifest | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.datasetRepo !== datasetRepo ||
    value.datasetRevision !== datasetRevision ||
    !isRecord(value.files)
  ) {
    return undefined;
  }

  const files: Record<string, CachedFileMetadata> = {};
  for (const [fileName, raw] of Object.entries(value.files)) {
    if (!isRecord(raw) || typeof raw.remotePath !== "string") return undefined;
    if (
      raw.size !== undefined &&
      (typeof raw.size !== "number" || !Number.isSafeInteger(raw.size) || raw.size < 0)
    ) {
      return undefined;
    }
    if (raw.identity !== undefined && typeof raw.identity !== "string") {
      return undefined;
    }
    files[fileName] = {
      remotePath: raw.remotePath,
      ...(raw.size === undefined ? {} : { size: raw.size }),
      ...(raw.identity === undefined ? {} : { identity: raw.identity }),
    };
  }

  return { schemaVersion: 1, datasetRepo, datasetRevision, files };
}
