// Read-only preflight. A failed/ambiguous lookup is never permission to replace
// immutable release bytes. Run before any GHCR, GitHub, or Registry mutation.
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const TIMEOUT_MS = 20_000;

/**
 * One lookup, retried while its answer says nothing about the version: a
 * timeout, a network error, a 5xx or a 429. Retrying is safe because the
 * lookup is read-only, and needed because a single slow answer is otherwise
 * enough to fail a release: on 2026-10-06 the Registry's data endpoints hung
 * while its health check answered, and v3.8.0 stopped at this guard with a
 * bare TimeoutError that did not even say which lookup it was.
 *
 * Only a definite 404 lets publication proceed. Every other answer still
 * fails closed, by name, once the attempts run out; a 403 or other 4xx is not
 * transient and fails at once.
 */
async function assertAbsent(check, { fetchImpl, attempts, retryDelayMs, sleep }) {
  let reason = "no attempt made";
  let made = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    made = attempt;
    if (attempt > 1) await sleep(retryDelayMs * 2 ** (attempt - 2));
    let response;
    try {
      response = await fetchImpl(check.url, { headers: check.headers, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
    } catch (err) {
      reason = err?.name === "TimeoutError" ? `timed out after ${TIMEOUT_MS / 1000}s` : String(err?.message ?? err);
      continue;
    }
    if (response.status === 404) return;
    if (response.ok) throw new Error(`${check.name} already exists; publish a new version instead of replacing released assets`);
    reason = `HTTP ${response.status}`;
    if (response.status !== 429 && response.status < 500) break;
  }
  throw new Error(`${check.name} preflight failed (${reason}, ${made} attempt${made === 1 ? "" : "s"}); refusing publication`);
}

export async function assertUnpublished({
  tag, repository, version, manifestVersion, token, fetchImpl = fetch,
  attempts = 4, retryDelayMs = 5_000, sleep = delay,
}) {
  if (!/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tag ?? "") || tag !== `v${version}` || version !== manifestVersion) {
    throw new Error("Release tag, package.json and manifest.json versions must match");
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) throw new Error("Invalid GitHub repository");
  const checks = [
    { name: `GitHub release ${tag}`, url: `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
      headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } },
    { name: `MCP Registry version ${version}`, url: `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent("io.github.fmadore/iwac-mcp-server")}/versions/${encodeURIComponent(version)}?include_deleted=true`, headers: {} },
  ];
  for (const check of checks) await assertAbsent(check, { fetchImpl, attempts, retryDelayMs, sleep });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  await assertUnpublished({ tag: process.env.TAG, repository: process.env.GITHUB_REPOSITORY,
    version: pkg.version, manifestVersion: manifest.version, token: process.env.GH_TOKEN });
  console.log(`Release preflight passed for ${process.env.TAG}`);
}
