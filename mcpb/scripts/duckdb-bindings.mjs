// Shared helpers for the platform-specific @duckdb/node-bindings-* packages that
// the packed .mcpb bundles ship. npm's optional-dependency filtering only installs
// the host platform's binding, so we fetch the others directly with `npm pack`
// (which ignores the os/cpu fields). Claude Desktop runs on macOS and Windows only,
// so Linux bindings are intentionally not part of optionalDependencies.
import { execSync, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

/** Map of `@duckdb/node-bindings-*` package name -> semver range from optionalDependencies. */
export function supportedBindings() {
  return Object.fromEntries(
    Object.entries(pkg.optionalDependencies ?? {}).filter(([name]) =>
      name.startsWith("@duckdb/node-bindings-"),
    ),
  );
}

/**
 * The exact version to fetch for a binding: the LOCKFILE-resolved version, so
 * the darwin/win32 bindings shipped in the bundles are the same DuckDB build as
 * the host binding `npm ci` installed and CI tested against. Deriving it from
 * the semver range's lower bound (the old behaviour, kept as fallback for a
 * missing lockfile entry) could skew platforms across versions once the range
 * resolves upward.
 */
function resolvedVersion(name, range) {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
    const v = lock.packages?.[`node_modules/${name}`]?.version;
    if (v) return v;
  } catch {
    /* no lockfile — fall through */
  }
  return range.replace(/^[^\d]*/, "");
}

/** Absolute path to a binding package's directory in node_modules (may not exist). */
export function bindingDir(name) {
  return path.join(ROOT, "node_modules", name);
}

/**
 * Ensure each named binding is extracted in node_modules, downloading only the
 * ones that are missing. `names` are full package names, e.g.
 * "@duckdb/node-bindings-win32-x64".
 */
export function ensureBindings(names) {
  const ranges = supportedBindings();
  const missing = names.filter(
    (name) => !fs.existsSync(path.join(bindingDir(name), "package.json")),
  );
  if (missing.length === 0) return;

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "duckdb-bindings-"));
  try {
    // On Windows prefer the native BSD tar at %WINDIR%\System32\tar.exe; the
    // MSYS/Cygwin tar from Git-for-Windows interprets "C:" as a remote host.
    const tarBin =
      process.platform === "win32" && process.env.WINDIR
        ? path.join(process.env.WINDIR, "System32", "tar.exe")
        : "tar";
    for (const name of missing) {
      const range = ranges[name];
      if (!range) throw new Error(`${name} is not listed in optionalDependencies`);
      const version = resolvedVersion(name, range);
      console.error(`fetching ${name}@${version}...`);
      // --json reports the exact tarball filename, so no reverse-engineering
      // the package name from `npm pack`'s output naming convention.
      const packOut = execSync(`npm pack ${name}@${version} --json`, {
        cwd: staging,
        stdio: ["ignore", "pipe", "inherit"],
      }).toString();
      const filename = JSON.parse(packOut)[0]?.filename;
      if (!filename) throw new Error(`npm pack ${name}@${version} reported no tarball`);
      const dest = bindingDir(name);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(dest, { recursive: true });
      console.error(`extracting ${filename} -> ${name}`);
      execFileSync(
        tarBin,
        ["-xzf", path.join(staging, filename), "--strip-components=1", "-C", dest],
        { stdio: "inherit" },
      );
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
