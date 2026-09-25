import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { config, datasetCacheDir, PRIVATE_DATASET_REPO } from "../src/config.js";
import { ensureView, pendingRefresh, query, viewGeneration } from "../src/db.js";
import { downloadName, ensureSubset, pruneSubset } from "../src/hf.js";
import {
  CACHE_MANIFEST_FILE,
  parseCacheManifest,
  remoteIdentity,
} from "../src/hfCache.js";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function parquetIn(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).filter((name) => name.endsWith(".parquet")).sort();
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
      let { files, downloaded } = await ensureSubset("articles");
      assert.equal(await fs.readFile(files[0], "utf8"), "bravo");
      assert.equal(downloads, 1);
      assert.equal(downloaded, true);
      // The new revision lands beside the stale copy, never on top of it (a
      // live view may still be reading that). Pruning removes it afterwards.
      assert.notEqual(files[0], localFile);
      assert.equal(await fs.readFile(localFile, "utf8"), "alpha");
      await pruneSubset("articles", files);
      assert.deepEqual(await parquetIn(subsetDir), [path.basename(files[0])]);

      // A republish with another five-byte payload changes the LFS identity,
      // and with it the local name.
      payload = "cider";
      const previous = files[0];
      ({ files } = await ensureSubset("articles"));
      assert.equal(await fs.readFile(files[0], "utf8"), "cider");
      assert.notEqual(files[0], previous);
      assert.equal(downloads, 2);

      // Matching sidecar identity avoids both hashing and downloading.
      ({ downloaded } = await ensureSubset("articles"));
      assert.equal(downloads, 2);
      assert.equal(downloaded, false);

      // Losing the sidecar remains cheap: the matching LFS digest proves that
      // this copy is current, then a fresh sidecar is written.
      await fs.rm(path.join(subsetDir, CACHE_MANIFEST_FILE));
      await ensureSubset("articles");
      assert.equal(downloads, 2);
      const manifest = JSON.parse(
        await fs.readFile(path.join(subsetDir, CACHE_MANIFEST_FILE), "utf8"),
      ) as { files: Record<string, { identity?: string }> };
      assert.equal(manifest.files[path.basename(files[0])]?.identity, `lfs:${sha256("cider")}`);

      // A cache from before content-named downloads keeps its Hub file name:
      // once its digest verifies, upgrading must not download ~250 MB again.
      await fs.rm(subsetDir, { recursive: true });
      await fs.mkdir(subsetDir, { recursive: true });
      await fs.writeFile(localFile, "cider");
      ({ files, downloaded } = await ensureSubset("articles"));
      assert.deepEqual(files, [localFile]);
      assert.equal(downloaded, false);
      assert.equal(downloads, 2);
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
      const { files } = await ensureSubset("articles");
      // No content identity in this listing, so the Hub name is kept.
      assert.equal(path.basename(files[0]), "train.parquet");
      assert.equal(await fs.readFile(files[0], "utf8"), "private");
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
      assert.deepEqual((await ensureSubset("articles")).files, files);
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

describe("content-named downloads", () => {
  it("names a download after its content identity, and only then", () => {
    const entry = { type: "file" as const, path: "articles/train-00000-of-00001.parquet", lfs: { oid: "a".repeat(64) } };
    const name = downloadName(entry);
    assert.match(name, /^train-00000-of-00001\.[0-9a-f]{12}\.parquet$/);
    assert.equal(downloadName(entry), name);
    assert.notEqual(downloadName({ ...entry, lfs: { oid: "b".repeat(64) } }), name);
    // Nothing tells revisions apart without an identity, so keep the Hub name.
    assert.equal(downloadName({ type: "file", path: "articles/train.parquet" }), "train.parquet");
  });
});

describe("background dataset refresh", () => {
  it("serves the loaded view, then swaps to a newer revision and prunes the old file", async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "iwac-refresh-"));
    const original = { ...config };
    const originalFetch = globalThis.fetch;
    const originalError = console.error;
    const versions: Buffer[] = [];
    for (const [i, sql] of [
      `SELECT 1 AS "o:id", 'first' AS title`,
      `SELECT * FROM (VALUES (1, 'first', 'x'), (2, 'second', 'y')) t("o:id", title, added)`,
    ].entries()) {
      const file = path.join(cacheDir, `v${i}.parquet`);
      await query(`COPY (${sql}) TO '${file.replaceAll("\\", "/")}' (FORMAT parquet)`);
      versions.push(await fs.readFile(file));
      await fs.rm(file);
    }
    let payload: Buffer = versions[0];
    let hubDown = false;
    try {
      Object.assign(config, {
        cacheDir,
        datasetRepo: "example/iwac",
        datasetRevision: "main",
        offline: false,
        privateDataset: false,
        refreshIntervalMs: 1,
      });
      console.error = () => {};
      globalThis.fetch = (async (input) => {
        const url = String(input);
        if (hubDown) throw new Error("network down");
        if (url.includes("/api/datasets/")) {
          return Response.json([
            { type: "file", path: "images/train.parquet", size: payload.length, lfs: { oid: sha256(payload) } },
          ]);
        }
        return new Response(new Uint8Array(payload));
      }) as typeof fetch;

      const count = async () => Number((await query("SELECT count(*) AS n FROM images"))[0].n);
      const first = await ensureView("images");
      assert.equal(first.has("added"), false);
      assert.equal(await count(), 1);
      assert.equal(viewGeneration("images"), 1);

      // A newer revision is published. The call that notices is answered from
      // the loaded view at once; the swap happens in the background.
      payload = versions[1];
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal((await ensureView("images")).has("added"), false);
      await pendingRefresh("images");
      assert.equal((await ensureView("images")).has("added"), true);
      assert.equal(await count(), 2);
      assert.equal(viewGeneration("images"), 2);
      assert.equal((await parquetIn(path.join(cacheDir, "images"))).length, 1, "the replaced file is pruned");

      // A failed check keeps serving what was loaded.
      hubDown = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      await ensureView("images");
      await pendingRefresh("images");
      assert.equal(await count(), 2);
      assert.equal(viewGeneration("images"), 2);
    } finally {
      Object.assign(config, original);
      globalThis.fetch = originalFetch;
      console.error = originalError;
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });
});
