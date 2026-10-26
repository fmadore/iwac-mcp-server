// The SEP-2640 Skills extension: the Agent Skill served from the server itself,
// checked from the client side with the SDK's own SkillsClient.
//
// The point of this test is INTEGRITY, not that a resource exists. The skill is
// inlined into the bundle at build time (scripts/collect-skills.mjs), so the
// bytes a client reads have travelled: disk → esbuild define → JSON string →
// SDK catalogue → resources/read. Anything along that path could mangle a
// heredoc, drop a non-ASCII character (the skill is French-heavy), or serve a
// stale copy from an earlier build. SkillsClient.read() checks every file against
// the manifest's size and digest; on top of that, every assertion here re-reads
// the ORIGINAL file from disk, so a manifest computed from mangled bytes fails too.
//
// `attach()` is @experimental in the SDK, so this file is also the contract test
// that a minor SDK bump has not rewired it.
//
// Run via `npm run test:skills`. Requires a prior `npm run build`.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills";
import { createReporter } from "./_harness.mjs";
import { collectSkills, SKILLS_DIR } from "../scripts/collect-skills.mjs";
import { withFixtureScope } from "./_fixture-client.mjs";

const EXTENSION = "io.modelcontextprotocol/skills";

await withFixtureScope(async (fixtures) => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const reporter = createReporter();
  const { fail } = reporter;

  // Source of truth: the tree on disk, collected exactly as the bundler did,
  // grouped as { skill name: [relative paths] }.
  const collected = collectSkills(root);
  const onDisk = new Map();
  for (const key of Object.keys(collected.files)) {
    const [name, ...rest] = key.split("/");
    onDisk.set(name, [...(onDisk.get(name) ?? []), rest.join("/")]);
  }
  if (onDisk.size === 0) fail(`no skills found under ${SKILLS_DIR}: the fixture for this test is missing`);
  const diskBytes = (name, rel) => readFileSync(path.join(root, ...SKILLS_DIR.split("/"), name, ...rel.split("/")));

  const { client, close: closeClient } = await fixtures.connect({
    name: "skills-test", clientOptions: { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  });
  const skills = new SkillsClient(client);

  // --- capability ----------------------------------------------------------------
  if (!skills.supported) fail(`the ${EXTENSION} capability is not declared`);
  // The SDK catalogue serves resources/directory/read, so it is advertised; the
  // bare skill://<name> URI is that skill's directory, not a JSON document.
  if (!skills.directoryRead) fail("directoryRead is not advertised");
  const caps = client.getServerCapabilities();
  // Declaring an extension must not cost the capabilities McpServer derives.
  if (!caps?.tools || !caps?.resources) fail("declaring extensions dropped the tools/resources capabilities");
  if (caps?.resources?.listChanged !== false) fail(`resources.listChanged became ${caps?.resources?.listChanged}`);

  // --- skills/list -----------------------------------------------------------------
  const listing = await skills.list();
  if (listing.invalid.length) fail(`skills/list returned invalid entries: ${JSON.stringify(listing.invalid)}`);
  if (listing.skills.length !== onDisk.size) {
    fail(`skills/list returned ${listing.skills.length} skill(s), disk has ${onDisk.size}`);
  }
  if (listing.cacheScope !== "public" || !(listing.ttlMs > 0)) fail("skills/list carries no public cache hint");

  for (const [name, paths] of onDisk) {
    const entryUri = `skill://${name}/SKILL.md`;
    const entry = listing.skills.find((s) => s.uri === entryUri);
    if (!entry) {
      fail(`skills/list has no entry at ${entryUri}`);
      continue;
    }
    if (entry.frontmatter.name !== name) fail(`${entryUri}: frontmatter name '${entry.frontmatter.name}'`);

    // The manifest must be complete: every file exactly once, SKILL.md included,
    // each digest and size matching the file on disk.
    const manifest = entry.resources;
    if (manifest.length !== paths.length) {
      fail(`${entryUri}: manifest lists ${manifest.length} files, disk has ${paths.length}`);
    }
    for (const rel of paths) {
      const uri = `skill://${name}/${rel}`;
      const listed = manifest.find((r) => r.uri === uri);
      if (!listed) {
        fail(`${entryUri}: ${uri} missing from the manifest`);
        continue;
      }
      const bytes = diskBytes(name, rel);
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (listed.digest !== digest) fail(`${uri}: manifest digest ${listed.digest} != ${digest} on disk`);
      if (listed.size !== bytes.byteLength) fail(`${uri}: manifest size ${listed.size} != ${bytes.byteLength} on disk`);

      // SkillsClient.read verifies size and digest against the entry (and, for
      // SKILL.md, the frontmatter); the disk comparison catches a manifest that
      // was itself computed from mangled bytes.
      try {
        const file = await skills.read(entry, rel);
        if (!file.verified) fail(`${uri}: read was not verified`);
        if (file.text !== bytes.toString("utf8")) fail(`${uri}: served text differs from the file on disk`);
      } catch (err) {
        fail(`${uri}: ${err?.message ?? err}`);
      }
    }

    // skills/get answers for the same skill, identically.
    const got = await skills.get(entryUri);
    if (got.cacheScope !== "public" || got.ttlMs !== listing.ttlMs) fail(`skills/get ${entryUri}: cache hints differ`);
    if (JSON.stringify(got.skill) !== JSON.stringify(entry)) {
      fail(`skills/get ${entryUri}: entry differs from the one skills/list returned`);
    }

    // Directory reads cover every file, walking down from the skill's root.
    const seen = [];
    const walk = async (dirUri) => {
      for (const child of (await skills.readDirectory(dirUri)).resources) {
        if (child.mimeType === "inode/directory") await walk(child.uri);
        else seen.push(child.uri);
      }
    };
    await walk(`skill://${name}`);
    const expected = paths.map((rel) => `skill://${name}/${rel}`).sort();
    if (JSON.stringify(seen.sort()) !== JSON.stringify(expected)) {
      fail(`directory reads under skill://${name} found ${seen.length} files, disk has ${expected.length}`);
    }
  }

  // --- what a host without the extension sees ----------------------------------------
  // Claude Desktop and Claude Code do not speak SEP-2640: they list resources and
  // read them by URI. SKILL.md names its references by relative path, so EVERY
  // file must be listed, not only SKILL.md (the SDK's own catalogue lists one entry
  // per skill), and each must say what it is.
  const resources = (await client.listResources()).resources;
  const uris = resources.map((r) => r.uri);
  if (new Set(uris).size !== uris.length) fail("resources/list contains duplicate URIs");
  for (const [name, paths] of onDisk) {
    const skill = listing.skills.find((s) => s.uri === `skill://${name}/SKILL.md`);
    for (const rel of paths) {
      const uri = `skill://${name}/${rel}`;
      const listed = resources.find((r) => r.uri === uri);
      if (!listed) {
        fail(`${uri} is not in resources/list`);
        continue;
      }
      const { mimeType } = collected.described[`${name}/${rel}`];
      if (listed.mimeType !== mimeType) fail(`${uri}: resources/list says mimeType '${listed.mimeType}', expected '${mimeType}'`);
      if (listed.size !== diskBytes(name, rel).byteLength) fail(`${uri}: resources/list size ${listed.size}`);
      if (rel === "SKILL.md") {
        // The entry point is described by its frontmatter: the activation text.
        if (listed.description !== skill?.frontmatter.description) {
          fail(`${uri}: resources/list description is not the SKILL.md frontmatter`);
        }
      } else if (!listed.title || !listed.description) {
        fail(`${uri}: no title or description in resources/list, so a host cannot tell what it is`);
      }
    }
  }
  const templates = (await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
  if (!templates.includes("skill://{+path}")) fail(`skill://{+path} is not in resources/templates/list: ${templates}`);

  // --- unknown URIs still fail ---------------------------------------------------------
  // A typo must not resolve to something plausible-looking.
  try {
    await client.readResource({ uri: "skill://iwac-mcp/references/does-not-exist.md" });
    fail("reading a non-existent skill file resolved instead of erroring");
  } catch {
    // expected
  }
  // A URI that identifies no served skill is -32602, per the SEP.
  try {
    await skills.get("skill://absent/SKILL.md");
    fail("skills/get resolved an unknown skill instead of erroring");
  } catch (err) {
    if (err?.code !== -32602) fail(`skills/get unknown skill: code ${err?.code}, expected -32602`);
  }

  await closeClient();

  // --- 2025-era clients ------------------------------------------------------------------
  // The extension works on both protocol eras; only the cache fields are modern.
  const legacy = await fixtures.connect({ name: "skills-test-legacy" });
  const legacySkills = new SkillsClient(legacy.client);
  const legacyListing = await legacySkills.list();
  if (JSON.stringify(legacyListing.skills) !== JSON.stringify(listing.skills)) {
    fail("legacy and modern skill manifests differ");
  }
  for (const skill of legacyListing.skills) {
    const text = (await legacy.client.readResource({ uri: skill.uri })).contents?.[0]?.text;
    if (text !== diskBytes(skill.frontmatter.name, "SKILL.md").toString("utf8")) {
      fail(`${skill.uri}: plain resources/read over a legacy connection differs from disk`);
    }
  }
  await legacy.close();

  const total = [...onDisk.values()].reduce((a, p) => a + p.length, 0);
  if (reporter.failures()) {
    console.error(`\nskills: ${reporter.failures()} failure(s)`);
    process.exitCode = 1;
  } else console.log(`skills: OK. ${onDisk.size} skill(s), ${total} files served and verified byte-for-byte`);
});
