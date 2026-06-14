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
const DUCKDB_DIR = path.join(ROOT, "node_modules", "@duckdb");

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

/** Map of `@duckdb/node-bindings-*` package name -> semver range from optionalDependencies. */
export function supportedBindings() {
  return Object.fromEntries(
    Object.entries(pkg.optionalDependencies ?? {}).filter(([name]) =>
      name.startsWith("@duckdb/node-bindings-"),
    ),
  );
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
    for (const name of missing) {
      const range = ranges[name];
      if (!range) throw new Error(`${name} is not listed in optionalDependencies`);
      const version = range.replace(/^[^\d]*/, "");
      console.error(`fetching ${name}@${version}...`);
      execSync(`npm pack ${name}@${version}`, { cwd: staging, stdio: ["ignore", "pipe", "inherit"] });
    }
    // On Windows prefer the native BSD tar at %WINDIR%\System32\tar.exe; the
    // MSYS/Cygwin tar from Git-for-Windows interprets "C:" as a remote host.
    const tarBin =
      process.platform === "win32" && process.env.WINDIR
        ? path.join(process.env.WINDIR, "System32", "tar.exe")
        : "tar";
    for (const tarball of fs.readdirSync(staging).filter((f) => f.endsWith(".tgz"))) {
      // e.g. duckdb-node-bindings-darwin-arm64-1.5.3-r.2.tgz -> @duckdb/node-bindings-darwin-arm64
      const match = tarball.match(/^duckdb-(node-bindings-[a-z0-9-]+)-\d/);
      if (!match) {
        console.error(`skip unrecognised tarball ${tarball}`);
        continue;
      }
      const dest = path.join(DUCKDB_DIR, match[1]);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(dest, { recursive: true });
      console.error(`extracting ${tarball} -> @duckdb/${match[1]}`);
      execFileSync(
        tarBin,
        ["-xzf", path.join(staging, tarball), "--strip-components=1", "-C", dest],
        { stdio: "inherit" },
      );
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
