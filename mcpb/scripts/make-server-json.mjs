// Generate server.json (repo root) for publishing to the official MCP Registry
// (registry.modelcontextprotocol.io), schema 2025-12-11.
//
// Everything is DERIVED so it cannot drift: version + description come from
// package.json / manifest.json, and fileSha256 is computed from the freshly
// packed .mcpb artifacts (run `npm run pack-platforms` first — the hashes must
// match the exact bytes uploaded as GitHub release assets, which is why the
// release workflow generates server.json in the same job that packs and
// uploads them). The output is gitignored; regenerate, never hand-edit.
//
// Usage: node scripts/make-server-json.mjs [vX.Y.Z]
//   The optional tag argument is a guard: it must match package.json's version
//   (the registry rejects reused versions, so a tag/version mismatch in CI
//   should fail loudly before anything is published).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const mcpbDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(mcpbDir, "..");
const pkg = JSON.parse(readFileSync(join(mcpbDir, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(mcpbDir, "manifest.json"), "utf8"));
const version = pkg.version;

const tag = process.argv[2];
if (tag && tag.replace(/^v/, "") !== version) {
  console.error(`make-server-json: tag ${tag} does not match package.json version ${version}`);
  process.exit(1);
}
if (manifest.version !== version) {
  console.error(`make-server-json: manifest.json version ${manifest.version} does not match package.json version ${version}`);
  process.exit(1);
}

const REPO_URL = "https://github.com/fmadore/iwac-mcp-server";

/** MCPB package entry for one packed OS bundle (must exist locally). */
function mcpbPackage(fileName) {
  const bytes = readFileSync(join(mcpbDir, fileName));
  return {
    registryType: "mcpb",
    identifier: `${REPO_URL}/releases/download/v${version}/${fileName}`,
    fileSha256: createHash("sha256").update(bytes).digest("hex"),
    transport: { type: "stdio" },
  };
}

const serverJson = {
  $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  name: "io.github.fmadore/iwac-mcp-server",
  title: manifest.display_name,
  description: manifest.description,
  version,
  websiteUrl: manifest.homepage,
  repository: { url: REPO_URL, source: "github" },
  icons: [
    {
      src: "https://raw.githubusercontent.com/fmadore/iwac-mcp-server/main/mcpb/icon.png",
      mimeType: "image/png",
    },
  ],
  // Public remote endpoint (no auth): the ChatGPT / skill-less client path.
  remotes: [{ type: "streamable-http", url: "https://islam.zmo.de/mcp/" }],
  // The Claude Desktop path: one .mcpb per OS, attached to the GitHub release.
  packages: [
    mcpbPackage("iwac-mcp-server-windows.mcpb"),
    mcpbPackage("iwac-mcp-server-macos.mcpb"),
  ],
};

const dest = join(repoRoot, "server.json");
writeFileSync(dest, `${JSON.stringify(serverJson, null, 2)}\n`);
console.log(`server.json written to ${dest} (version ${version})`);
