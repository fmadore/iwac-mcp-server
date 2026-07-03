// Build one .mcpb per supported OS, each containing only that OS's DuckDB bindings.
//
// Why per-OS bundles: a .mcpb is a self-contained zip, so a single "universal"
// bundle has to embed the native DuckDB binary for every platform. With all of
// macOS + Windows + Linux that archive is ~157 MB / ~490 MB unpacked, which
// Claude Desktop's installer fails to extract reliably (it leaves a partial,
// non-working install). Claude Desktop runs on macOS and Windows only, and its
// installer selects the matching CPU arch at install time, so shipping one bundle
// per OS (with both arches inside) keeps each archive small (~45 MB Windows,
// ~90 MB macOS) and extraction reliable.
//
// The non-target binding directories are moved OUT of the pack tree (into a stash
// beside the repo) for the duration of each `mcpb pack`, then moved back — so this
// runs offline against whatever bindings ensureBindings() has placed on disk.
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT, ensureBindings, supportedBindings } from "./duckdb-bindings.mjs";

const DUCKDB_DIR = path.join(ROOT, "node_modules", "@duckdb");
const MANIFEST = path.join(ROOT, "manifest.json");
// Stash lives one level above the pack dir (mcpb/) so it is never swept into a bundle.
const STASH = path.join(ROOT, "..", ".duckdb-binding-stash");

const TARGETS = [
  {
    os: "darwin",
    outfile: "iwac-mcp-server-macos.mcpb",
    bindings: ["@duckdb/node-bindings-darwin-x64", "@duckdb/node-bindings-darwin-arm64"],
  },
  {
    os: "win32",
    outfile: "iwac-mcp-server-windows.mcpb",
    bindings: ["@duckdb/node-bindings-win32-x64", "@duckdb/node-bindings-win32-arm64"],
  },
];
// Build the host OS last so node_modules is left holding the host's bindings —
// handy for a follow-up `node smoke-test.mjs`.
TARGETS.sort((a, b) => Number(a.os === process.platform) - Number(b.os === process.platform));

// Make sure every binding we ship is on disk (downloads only what's missing).
ensureBindings(Object.keys(supportedBindings()));

const shortName = (n) => n.replace("@duckdb/", "");
const bindingDirNames = () =>
  fs.existsSync(DUCKDB_DIR)
    ? fs.readdirSync(DUCKDB_DIR).filter((d) => /^node-bindings-(darwin|win32|linux)-/.test(d))
    : [];

const originalManifest = fs.readFileSync(MANIFEST, "utf8");
const manifest = JSON.parse(originalManifest);

try {
  for (const target of TARGETS) {
    console.error(`\n=== ${target.outfile}  (platform: ${target.os}) ===`);

    for (const name of target.bindings) {
      if (!fs.existsSync(path.join(ROOT, "node_modules", name, "package.json"))) {
        throw new Error(`missing ${name} — run: npm run install-bindings`);
      }
    }

    const keep = new Set(target.bindings.map(shortName));
    fs.mkdirSync(STASH, { recursive: true });
    const stashed = bindingDirNames().filter((d) => !keep.has(d));
    for (const d of stashed) fs.renameSync(path.join(DUCKDB_DIR, d), path.join(STASH, d));

    // Per-bundle manifest declares only this OS, so Claude Desktop refuses a
    // wrong-OS install instead of shipping a binary that can't load.
    manifest.compatibility.platforms = [target.os];
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");

    try {
      fs.rmSync(path.join(ROOT, target.outfile), { force: true });
      execSync(`mcpb pack . ${target.outfile}`, { cwd: ROOT, stdio: "inherit" });
      execSync(`mcpb clean ${target.outfile}`, { cwd: ROOT, stdio: "inherit" });
      const mb = (fs.statSync(path.join(ROOT, target.outfile)).size / 1048576).toFixed(1);
      console.error(`-> ${target.outfile}: ${mb} MB  (bindings: ${[...keep].join(", ")})`);
    } finally {
      for (const d of stashed) fs.renameSync(path.join(STASH, d), path.join(DUCKDB_DIR, d));
      fs.rmSync(STASH, { recursive: true, force: true });
    }
  }
} finally {
  fs.writeFileSync(MANIFEST, originalManifest);
}

console.error("\nDone. Upload both per-OS .mcpb files to the GitHub release.");
