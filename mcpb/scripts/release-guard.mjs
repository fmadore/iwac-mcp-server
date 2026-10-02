// Read-only preflight. A failed/ambiguous lookup is never permission to replace
// immutable release bytes. Run before any GHCR, GitHub, or Registry mutation.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export async function assertUnpublished({ tag, repository, version, manifestVersion, token, fetchImpl = fetch }) {
  if (!/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tag ?? "") || tag !== `v${version}` || version !== manifestVersion) {
    throw new Error("Release tag, package.json and manifest.json versions must match");
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) throw new Error("Invalid GitHub repository");
  const checks = [
    { name: "GitHub release", url: `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
      headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } },
    { name: "MCP Registry version", url: `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent("io.github.fmadore/iwac-mcp-server")}/versions/${encodeURIComponent(version)}?include_deleted=true`, headers: {} },
  ];
  for (const check of checks) {
    const response = await fetchImpl(check.url, { headers: check.headers, signal: AbortSignal.timeout(20_000), redirect: "error" });
    if (response.ok) throw new Error(`${check.name} already exists for ${tag}; publish a new version instead of replacing released assets`);
    if (response.status !== 404) throw new Error(`${check.name} preflight failed (HTTP ${response.status}); refusing publication`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  await assertUnpublished({ tag: process.env.TAG, repository: process.env.GITHUB_REPOSITORY,
    version: pkg.version, manifestVersion: manifest.version, token: process.env.GH_TOKEN });
  console.log(`Release preflight passed for ${process.env.TAG}`);
}
