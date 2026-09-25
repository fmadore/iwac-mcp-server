// Build one .mcpb per supported OS, each containing only that OS's DuckDB bindings.
//
// Why per-OS bundles: a .mcpb is a self-contained zip, so a single "universal"
// bundle has to embed the native DuckDB binary for every platform. With all of
// macOS + Windows + Linux that archive is ~157 MB / ~490 MB unpacked, which
// Claude Desktop's installer fails to extract reliably (it leaves a partial,
// non-working install). Claude Desktop runs on macOS and Windows only, and its
// installer selects the matching CPU arch at install time, so shipping one bundle
// per OS (with both arches inside) keeps each archive small and extraction
// reliable.
//
// Why a staging directory: this used to pack mcpb/ itself and rely on
// `mcpb clean` to drop the development packages. It never did. clean's
// dependency walker stops at the first module .mcpbignore had already removed,
// logs "Some modules already removed, skipping remaining cleanup", and prunes
// nothing. Every bundle up to v3.6.0 therefore shipped the dev toolchain; the
// native Linux binaries of Biome and TypeScript 7 alone were 33 MB of a 112 MB
// macOS bundle. Each bundle is now assembled in a temporary directory from what
// the server actually loads. scripts/bundle.mjs inlines everything except the
// externals @duckdb/* and @google/genai, so node_modules holds exactly those two
// and what they resolve at runtime, with only the target OS's DuckDB bindings.
// The working tree is never modified: the per-OS manifest is written into the
// stage.
//
// .mcpbignore is deliberately NOT applied to the stage. Its `src/` line was
// meant for this project's TypeScript sources, but ignore patterns without a
// leading slash match at any depth, and it silently removed
// google-auth-library's and gaxios's `build/src/`, the code @google/genai loads.
// Semantic search could not start in any bundle packed that way. The stage
// holds only what should ship, and mcpb's built-in excludes (*.map, *.d.ts, …)
// still apply. After packing, verifyBundle() unpacks each archive and loads
// the runtime packages from it, so a bundle that cannot import them fails
// the release instead of reaching users.
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ROOT, ensureBindings, supportedBindings } from "./duckdb-bindings.mjs";

// The mcpb CLI from our own devDependencies, invoked by path so the script
// works under plain `node scripts/pack-platforms.mjs`, not only via npm run
// (which is what put node_modules/.bin on PATH before).
const MCPB_BIN = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "mcpb.cmd" : "mcpb");

/** What the built server imports at runtime: the esbuild externals (scripts/bundle.mjs). */
const RUNTIME_ROOTS = ["@duckdb/node-api", "@google/genai"];

/** Files a bundle carries beside server/ and node_modules/. */
const BUNDLE_FILES = ["manifest.json", "package.json", "README.md", "icon.png"];

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

/** The directory Node would load `name` from when required inside `fromDir`:
 * the nearest node_modules/<name>, walking up to ROOT. */
function resolvePackage(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    if (dir === ROOT || path.dirname(dir) === dir) return undefined;
  }
}

/**
 * Every installed package directory the runtime roots need, following
 * `dependencies` and `optionalDependencies`. Peer dependencies are not
 * followed: they are the host's to provide, and @google/genai's optional peer
 * on the v1 MCP SDK is what npm's own `--omit=dev` view drags in along with
 * Express. DuckDB bindings for any other platform are skipped. A required
 * dependency that is not installed is an error, not a quietly smaller bundle.
 */
function runtimeClosure(keepBindings) {
  const seen = new Set();
  const visit = (dir) => {
    if (seen.has(dir)) return;
    seen.add(dir);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const optional = manifest.optionalDependencies ?? {};
    for (const name of Object.keys({ ...optional, ...manifest.dependencies })) {
      if (name.startsWith("@duckdb/node-bindings-") && !keepBindings.has(name)) continue;
      const found = resolvePackage(name, dir);
      if (found) visit(found);
      else if (!(name in optional)) throw new Error(`${name}, required by ${manifest.name}, is not installed`);
    }
  };
  for (const name of RUNTIME_ROOTS) {
    const dir = resolvePackage(name, ROOT);
    if (!dir) throw new Error(`${name} is not installed; run: npm ci`);
    visit(dir);
  }
  return [...seen].sort();
}

/** Assemble one target's bundle tree in a fresh temporary directory. */
function stage(target, manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `iwac-mcpb-${target.os}-`));
  for (const file of BUNDLE_FILES) fs.copyFileSync(path.join(ROOT, file), path.join(dir, file));
  fs.cpSync(path.join(ROOT, "server"), path.join(dir, "server"), { recursive: true });
  // Per-bundle manifest declares only this OS, so Claude Desktop refuses a
  // wrong-OS install instead of shipping a binary that can't load.
  const perOs = { ...manifest, compatibility: { ...manifest.compatibility, platforms: [target.os] } };
  fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(perOs, null, 2)}\n`);

  const packages = runtimeClosure(new Set(target.bindings));
  for (const pkgDir of packages) {
    // A package's own nested node_modules are copied as packages in their own
    // right when the closure reaches them, and not otherwise.
    const nested = path.join(pkgDir, "node_modules");
    fs.cpSync(pkgDir, path.join(dir, path.relative(ROOT, pkgDir)), {
      recursive: true,
      filter: (src) => src !== nested && !src.startsWith(nested + path.sep),
    });
  }
  return { dir, packages };
}

/**
 * Unpack a finished bundle and prove it can load what the server needs:
 * @google/genai is imported for real (pure JavaScript, so it loads on any
 * host), and for DuckDB, whose native binding only loads on its own OS, the
 * entry module and each target binary must be present. This checks the
 * archive, not the staging directory, so it also catches anything the pack
 * step itself drops.
 */
function verifyBundle(outfile, target) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iwac-mcpb-verify-"));
  try {
    execSync(`"${MCPB_BIN}" unpack "${outfile}" "${dir}"`, { cwd: ROOT, stdio: "ignore" });
    execSync(`"${process.execPath}" --input-type=module -e "await import('@google/genai')"`, { cwd: dir, stdio: "pipe" });
    const required = [
      "server/index.js",
      "node_modules/@duckdb/node-api/package.json",
      ...target.bindings.map((name) => `node_modules/${name}/duckdb.node`),
    ];
    const missing = required.filter((file) => !fs.existsSync(path.join(dir, file)));
    if (missing.length) throw new Error(`${path.basename(outfile)} is missing ${missing.join(", ")}`);
  } catch (err) {
    const detail = err.stderr ? String(err.stderr).trim() : err.message;
    throw new Error(`${path.basename(outfile)} failed verification: ${detail}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Leftovers of the in-place packer this replaced, if a run of it was killed
// mid-pack: restore the pristine manifest and the stashed bindings.
const legacyManifestBackup = path.join(ROOT, "manifest.json.orig");
if (fs.existsSync(legacyManifestBackup)) {
  console.error("recovering pristine manifest.json from manifest.json.orig (an older packer was interrupted)");
  fs.copyFileSync(legacyManifestBackup, path.join(ROOT, "manifest.json"));
  fs.rmSync(legacyManifestBackup);
}
const legacyStash = path.join(ROOT, "..", ".duckdb-binding-stash");
if (fs.existsSync(legacyStash)) {
  for (const d of fs.readdirSync(legacyStash)) {
    const dest = path.join(ROOT, "node_modules", "@duckdb", d);
    if (!fs.existsSync(dest)) fs.renameSync(path.join(legacyStash, d), dest);
  }
  fs.rmSync(legacyStash, { recursive: true, force: true });
}

if (!fs.existsSync(MCPB_BIN)) {
  console.error(`mcpb CLI not found at ${MCPB_BIN}; run: npm install`);
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, "server", "index.js"))) {
  console.error("server/index.js not found; run: npm run build");
  process.exit(1);
}

// Make sure every binding we ship is on disk (downloads only what's missing).
ensureBindings(Object.keys(supportedBindings()));

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

for (const target of TARGETS) {
  console.error(`\n=== ${target.outfile}  (platform: ${target.os}) ===`);
  const { dir, packages } = stage(target, manifest);
  try {
    for (const name of target.bindings) {
      if (!fs.existsSync(path.join(dir, "node_modules", name, "package.json"))) {
        throw new Error(`missing ${name}; run: npm run install-bindings`);
      }
    }
    const outfile = path.join(ROOT, target.outfile);
    fs.rmSync(outfile, { force: true });
    execSync(`"${MCPB_BIN}" pack "${dir}" "${outfile}"`, { cwd: ROOT, stdio: "inherit" });
    execSync(`"${MCPB_BIN}" clean "${outfile}"`, { cwd: ROOT, stdio: "inherit" });
    verifyBundle(outfile, target);
    const mb = (fs.statSync(outfile).size / 1048576).toFixed(1);
    console.error(`-> ${target.outfile}: ${mb} MB, ${packages.length} runtime packages`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.error("\nDone. Upload both per-OS .mcpb files to the GitHub release.");
