// Ensure all platform DuckDB bindings are present in node_modules so the packaged
// .mcpb bundle works on every platform declared in manifest.compatibility.platforms.
//
// Uses `npm pack` to download each binding tarball, then extracts it in place.
// This bypasses npm's optional-dependency os/cpu filtering.
import { execSync, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..");
const pkgJsonPath = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));

const bindings = Object.keys(pkg.optionalDependencies ?? {}).filter((n) =>
  n.startsWith("@duckdb/node-bindings-"),
);
if (bindings.length === 0) {
  console.error("no @duckdb/node-bindings-* in optionalDependencies");
  process.exit(1);
}

const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "duckdb-bindings-"));
console.error(`staging in ${stagingDir}`);

for (const name of bindings) {
  const version = pkg.optionalDependencies[name].replace(/^[^\d]*/, "");
  const spec = `${name}@${version}`;
  console.error(`fetching ${spec}...`);
  execSync(`npm pack ${spec}`, { cwd: stagingDir, stdio: ["ignore", "pipe", "inherit"] });
}

// Extract each tarball into node_modules/<package-name>/
const tarballs = fs.readdirSync(stagingDir).filter((f) => f.endsWith(".tgz"));
for (const tarball of tarballs) {
  // e.g. duckdb-node-bindings-darwin-arm64-1.5.2-r.1.tgz -> @duckdb/node-bindings-darwin-arm64
  const match = tarball.match(/^duckdb-(node-bindings-[a-z0-9-]+)-/);
  if (!match) {
    console.error(`skip unrecognised tarball ${tarball}`);
    continue;
  }
  const pkgName = `@duckdb/${match[1]}`;
  const dest = path.join(root, "node_modules", pkgName);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  console.error(`extracting ${tarball} -> ${dest}`);
  // On Windows prefer the native BSD tar at %WINDIR%\System32\tar.exe; the MSYS/Cygwin
  // tar from Git-for-Windows interprets "C:" as a remote host.
  const tarBin =
    process.platform === "win32" && process.env.WINDIR
      ? path.join(process.env.WINDIR, "System32", "tar.exe")
      : "tar";
  execFileSync(
    tarBin,
    [
      "-xzf",
      path.join(stagingDir, tarball),
      "--strip-components=1",
      "-C",
      dest,
    ],
    { stdio: "inherit" },
  );
}

fs.rmSync(stagingDir, { recursive: true, force: true });
console.error(`installed ${tarballs.length} bindings`);
