import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { config, datasetCacheDir, PRIVATE_DATASET_REPO } from "../src/config.js";
import { ensureSubset } from "../src/hf.js";
import {
  CACHE_MANIFEST_FILE,
  parseCacheManifest,
  remoteIdentity,
} from "../src/hfCache.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("Hugging Face cache freshness", () => {
  it("prefers immutable content identities and rejects unrelated sidecars", () => {
    assert.equal(
      remoteIdentity({
        type: "file",
        path: "articles/train.parquet",
        oid: "GIT",
        xetHash: "XET",
        lfs: { oid: "A".repeat(64) },
      }),
      `lfs:${"a".repeat(64)}`,
    );
    assert.equal(
      remoteIdentity({ type: "file", path: "train.parquet", oid: "ABC" }),
      "git:abc",
    );
    assert.equal(parseCacheManifest({}, "repo", "main"), undefined);
    assert.equal(
      parseCacheManifest(
        {
          schemaVersion: 1,
          datasetRepo: "another/repo",
          datasetRevision: "main",
          files: {},
        },
        "repo",
        "main",
      ),
      undefined,
    );
  });

  it("refreshes a same-sized republish and hashes a legacy cache only once", async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "iwac-hf-cache-"));
    const subsetDir = path.join(cacheDir, "articles");
    const fileName = "train-00000-of-00001.parquet";
    const localFile = path.join(subsetDir, fileName);
    await fs.mkdir(subsetDir, { recursive: true });
    await fs.writeFile(localFile, "alpha");

    const original = {
      cacheDir: config.cacheDir,
      datasetRepo: config.datasetRepo,
      datasetRevision: config.datasetRevision,
      offline: config.offline,
      fetch: globalThis.fetch,
      consoleError: console.error,
    };
    let payload = "bravo";
    let downloads = 0;

    config.cacheDir = cacheDir;
    config.datasetRepo = "example/iwac";
    config.datasetRevision = "main";
    config.offline = false;
    console.error = () => {};
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("/api/datasets/")) {
        return Response.json([
          {
            type: "file",
            path: `articles/${fileName}`,
            size: Buffer.byteLength(payload),
            oid: `git-${sha256(payload)}`,
            lfs: { oid: sha256(payload), size: Buffer.byteLength(payload) },
          },
        ]);
      }
      if (url.includes("/resolve/")) {
        downloads += 1;
        return new Response(payload, { status: 200 });
      }
      throw new Error(`Unexpected test URL: ${url}`);
    }) as typeof fetch;

    try {
      // The legacy file has the same length as the Hub file. Its SHA differs,
      // so size alone must not suppress the initial refresh.
      await ensureSubset("articles");
      assert.equal(await fs.readFile(localFile, "utf8"), "bravo");
      assert.equal(downloads, 1);

      // A republish with another five-byte payload changes the LFS identity.
      payload = "cider";
      await ensureSubset("articles");
      assert.equal(await fs.readFile(localFile, "utf8"), "cider");
      assert.equal(downloads, 2);

      // Matching sidecar identity avoids both hashing and downloading.
      await ensureSubset("articles");
      assert.equal(downloads, 2);

      // Losing the sidecar remains cheap: the matching LFS digest proves that
      // this legacy file is current, then a fresh sidecar is written.
      await fs.rm(path.join(subsetDir, CACHE_MANIFEST_FILE));
      await ensureSubset("articles");
      assert.equal(downloads, 2);
      const manifest = JSON.parse(
        await fs.readFile(path.join(subsetDir, CACHE_MANIFEST_FILE), "utf8"),
      ) as { files: Record<string, { identity?: string }> };
      assert.equal(manifest.files[fileName]?.identity, `lfs:${sha256("cider")}`);
    } finally {
      config.cacheDir = original.cacheDir;
      config.datasetRepo = original.datasetRepo;
      config.datasetRevision = original.datasetRevision;
      config.offline = original.offline;
      globalThis.fetch = original.fetch;
      console.error = original.consoleError;
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });
});


describe("private dataset access", () => {
  it("isolates caches and authenticates both requests without public token use", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "iwac-private-"));
    const original = { ...config };
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; auth: string | null }> = [];
    try {
      assert.notEqual(datasetCacheDir(base, false), datasetCacheDir(base, true));
      config.privateDataset = true;
      config.datasetRepo = PRIVATE_DATASET_REPO;
      config.cacheDir = datasetCacheDir(base, true);
      config.offline = false;
      config.hfToken = "hf_test_only";
      globalThis.fetch = (async (input, init) => {
        requests.push({ url: String(input), auth: new Headers(init?.headers).get("Authorization") });
        return String(input).includes("/api/datasets/")
          ? Response.json([{ type: "file", path: "articles/train.parquet", size: 7 }])
          : new Response("private");
      }) as typeof fetch;
      const dir = await ensureSubset("articles");
      assert.equal(await fs.readFile(path.join(dir, "train.parquet"), "utf8"), "private");
      assert.equal(requests.length, 2);
      assert.ok(requests.every(r => r.auth === "Bearer hf_test_only" && r.url.includes(PRIVATE_DATASET_REPO)));
      // Even with cached text, invalid/missing credentials must fail online.
      config.hfToken = undefined;
      await assert.rejects(ensureSubset("articles"), /requires IWAC_HF_TOKEN/);
      config.hfToken = "hf_test_only";
      for (const status of [401, 403, 404]) {
        globalThis.fetch = (async () => new Response(null, { status })) as typeof fetch;
        await assert.rejects(ensureSubset("articles"), new RegExp(`HTTP ${status}`));
      }
      config.offline = true;
      assert.equal(await ensureSubset("articles"), dir);
      config.privateDataset = false;
      config.cacheDir = datasetCacheDir(base, false);
      await assert.rejects(ensureSubset("articles"), /no cached parquet/);
      config.offline = false;
      globalThis.fetch = (async (_input, init) => {
        assert.equal(new Headers(init?.headers).get("Authorization"), null);
        return Response.json([]);
      }) as typeof fetch;
      await assert.rejects(ensureSubset("articles"), /No parquet files/);
    } finally {
      Object.assign(config, original);
      globalThis.fetch = originalFetch;
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});
