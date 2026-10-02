// Foreign-platform bindings must match the tested DuckDB version and the
// lockfile's tarball digest. npm ci only installs the current host's binding.
import { execFileSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function supportedBindings() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  return Object.fromEntries(Object.entries(pkg.optionalDependencies ?? {})
    .filter(([name]) => name.startsWith("@duckdb/node-bindings-")));
}

export function bindingDir(name) {
  return path.join(ROOT, "node_modules", name);
}

/** A missing/skewed lock entry is a release error, never a range fallback. */
export function lockedBinding(name, lock) {
  if (!/^@duckdb\/node-bindings-(darwin|win32)-(x64|arm64)$/.test(name)) {
    throw new Error(`Unsupported DuckDB binding: ${name}`);
  }
  const entry = lock.packages?.[`node_modules/${name}`];
  const api = lock.packages?.["node_modules/@duckdb/node-api"];
  if (!entry?.version || !entry.integrity || entry.version !== api?.version) {
    throw new Error(`${name} must have integrity and match @duckdb/node-api in package-lock.json`);
  }
  if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(entry.version)) throw new Error(`Invalid binding version: ${entry.version}`);
  return entry;
}

export function verifyIntegrity(bytes, integrity) {
  // npm lockfile entries use sha512 SRI. Reject missing/unsupported algorithms.
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity ?? "");
  if (!match) throw new Error("Expected a sha512 integrity entry in package-lock.json");
  const expected = Buffer.from(match[1], "base64");
  const actual = createHash("sha512").update(bytes).digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("DuckDB binding tarball integrity mismatch");
  }
}

export function bindingFiles(name) {
  return ["duckdb.node", name.includes("-win32-") ? "duckdb.dll" : "libduckdb.dylib"];
}

export function bindingIsCurrent(dir, name, version) {
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    return installed.name === name && installed.version === version &&
      bindingFiles(name).every((file) => fs.statSync(path.join(dir, file)).isFile());
  } catch {
    return false;
  }
}

export function ensureBindings(names) {
  const ranges = supportedBindings();
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
  const needed = names.map((name) => {
    if (!(name in ranges)) throw new Error(`${name} is not listed in optionalDependencies`);
    return { name, ...lockedBinding(name, lock) };
  }).filter(({ name, version }) => !bindingIsCurrent(bindingDir(name), name, version));
  if (!needed.length) return;

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "duckdb-bindings-"));
  try {
    const tarBin = process.platform === "win32" && process.env.WINDIR
      ? path.join(process.env.WINDIR, "System32", "tar.exe") : "tar";
    // Running npm's JS entry point avoids cmd.exe quoting on Windows.
    const npmCli = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
    for (const { name, version, integrity } of needed) {
      console.error(`fetching ${name}@${version} (locked integrity)...`);
      const args = ["pack", `${name}@${version}`, "--json", "--ignore-scripts"];
      const output = fs.existsSync(npmCli)
        ? execFileSync(process.execPath, [npmCli, ...args], { cwd: staging, encoding: "utf8" })
        : execFileSync("npm", args, { cwd: staging, encoding: "utf8" });
      const filename = JSON.parse(output)[0]?.filename;
      if (!filename || path.basename(filename) !== filename) throw new Error(`Invalid npm pack filename for ${name}`);
      const archive = path.join(staging, filename);
      verifyIntegrity(fs.readFileSync(archive), integrity);
      const extracted = fs.mkdtempSync(path.join(staging, "verified-"));
      execFileSync(tarBin, ["-xzf", archive, "--strip-components=1", "-C", extracted], { stdio: "inherit" });
      if (!bindingIsCurrent(extracted, name, version)) throw new Error(`Incomplete or mismatched binding: ${name}`);
      const dest = bindingDir(name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(extracted, dest, { recursive: true });
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
