// `skill://` resources: the Agent Skill served from the server itself.
//
// The point of this test is INTEGRITY, not that a resource exists. The skill is
// inlined into the bundle at build time (scripts/collect-skills.mjs), so the
// bytes a client reads have travelled: disk → esbuild define → JSON string →
// resource handler. Anything along that path could mangle a heredoc, drop a
// non-ASCII character (the skill is French-heavy), or serve a stale copy from an
// earlier build. So every assertion here re-reads the ORIGINAL file from disk
// and compares against what came over the wire, and re-computes each digest
// rather than trusting the one the catalogue reports.
//
// Run via `npm run test:skills`. Requires a prior `npm run build`.
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { collectSkills, SKILLS_DIR } from "../scripts/collect-skills.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
function fail(msg) {
  failures++;
  console.error(`  FAIL: ${msg}`);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "server", "index.js")],
  stderr: "inherit",
  env: {
    ...process.env,
    IWAC_CACHE_DIR: path.join(root, "test", "fixtures"),
    IWAC_OFFLINE: "1",
    IWAC_SEMANTIC_SEARCH_ENABLED: "false",
  },
});

const client = new Client({ name: "skills-test", version: "0.0.0" });
await client.connect(transport);

// Source of truth: the tree on disk, collected exactly as the bundler did.
const onDisk = collectSkills(root);
if (onDisk.skills.length === 0) fail(`no skills found under ${SKILLS_DIR}: the fixture for this test is missing`);

const listed = (await client.listResources()).resources;
const byUri = new Map(listed.map((r) => [r.uri, r]));

for (const skill of onDisk.skills) {
  const catalogueUri = `skill://${skill.name}`;

  // --- the catalogue -------------------------------------------------------
  if (!byUri.has(catalogueUri)) fail(`${catalogueUri} is not in resources/list`);

  const catRes = await client.readResource({ uri: catalogueUri });
  const catBody = catRes.contents?.[0]?.text ?? "";
  let catalogue = null;
  try {
    catalogue = JSON.parse(catBody);
  } catch {
    fail(`${catalogueUri}: body is not valid JSON`);
  }

  if (catalogue) {
    if (catalogue.name !== skill.name) fail(`${catalogueUri}: name is '${catalogue.name}', expected '${skill.name}'`);
    if (catalogue.entry !== `skill://${skill.name}/SKILL.md`) {
      fail(`${catalogueUri}: entry is '${catalogue.entry}', expected the SKILL.md URI`);
    }
    if (catalogue.description !== skill.description) {
      fail(`${catalogueUri}: description does not match SKILL.md frontmatter`);
    }
    if ((catalogue.resources ?? []).length !== skill.files.length) {
      fail(`${catalogueUri}: lists ${catalogue.resources?.length} files, disk has ${skill.files.length}`);
    }
    // The catalogue must not smuggle the content it exists to summarise; that
    // would make reading it cost as much as reading every file.
    for (const r of catalogue.resources ?? []) {
      if ("text" in r) fail(`${catalogueUri}: entry ${r.uri} carries inline text; the catalogue must be metadata only`);
    }
  }

  // --- every file ----------------------------------------------------------
  for (const file of skill.files) {
    const meta = byUri.get(file.uri);
    if (!meta) {
      fail(`${file.uri} is not in resources/list`);
      continue;
    }
    if (meta.mimeType !== file.mimeType) {
      fail(`${file.uri}: resources/list says mimeType '${meta.mimeType}', expected '${file.mimeType}'`);
    }
    if (!meta.description) fail(`${file.uri}: no description in resources/list, so a host cannot tell what it is`);

    const res = await client.readResource({ uri: file.uri });
    const served = res.contents?.[0]?.text;
    if (typeof served !== "string") {
      fail(`${file.uri}: read returned no text`);
      continue;
    }

    // Byte-for-byte against the file on disk, not against the collector's copy
    // of it: this is the assertion that catches a mangled build.
    const diskPath = path.join(root, ...SKILLS_DIR.split("/"), skill.name, ...file.path.split("/"));
    const expected = readFileSync(diskPath, "utf8");
    if (served !== expected) {
      fail(`${file.uri}: served content differs from ${diskPath} (${served.length} vs ${expected.length} chars)`);
    }

    // Digest recomputed here, so a catalogue that reports a digest it did not
    // actually derive from the content fails.
    const digest = `sha256:${createHash("sha256").update(served).digest("hex")}`;
    const claimed = catalogue?.resources?.find((r) => r.uri === file.uri);
    if (!claimed) fail(`${file.uri}: absent from the catalogue`);
    else {
      if (claimed.digest !== digest) fail(`${file.uri}: catalogue digest ${claimed.digest} != actual ${digest}`);
      if (claimed.bytes !== Buffer.byteLength(served)) {
        fail(`${file.uri}: catalogue says ${claimed.bytes} bytes, served ${Buffer.byteLength(served)}`);
      }
    }
  }
}

// --- the namespace split -----------------------------------------------------
// The catalogue sits at the bare `skill://<name>` precisely because no file can
// live there. If a skill ever gained a file whose URI collided, one would
// silently shadow the other.
const uris = listed.map((r) => r.uri);
if (new Set(uris).size !== uris.length) fail("resources/list contains duplicate URIs");

// --- unknown URIs still fail -------------------------------------------------
// A typo must not resolve to something plausible-looking.
try {
  await client.readResource({ uri: "skill://iwac-mcp/references/does-not-exist.md" });
  fail("reading a non-existent skill file resolved instead of erroring");
} catch {
  // expected
}

await client.close();

const total = onDisk.skills.reduce((a, s) => a + s.files.length, 0);
if (failures) {
  console.error(`\nskills: ${failures} failure(s)`);
  process.exit(1);
}
console.log(`skills: OK. ${onDisk.skills.length} skill(s), ${total} files served and verified byte-for-byte`);
