// Skills over MCP: serve the repo's Agent Skill from the server itself.
//
// STATUS: PROTOTYPE. This tracks a spec proposal that has NOT been accepted
// (SEP-2640, see below). The `skill://` URIs and the catalogue shape are not a
// supported interface and may change or be withdrawn without a major version
// bump. The `.zip` on the GitHub release remains the supported way to install
// the skill. Nothing else in the server depends on this module, so it can be
// removed by deleting one call in register.ts. TODO.md tracks the decision.
//
// WHY. The `iwac-mcp` skill is what turns 34 raw tools into a research
// workflow, but it has always shipped out-of-band: a `.zip` on the GitHub
// release that the user downloads and unpacks into `~/.claude/skills/`. Two
// consequences: the install is a manual, per-client ritual, and anyone reaching
// this server over remote HTTP (islam.zmo.de/mcp, added as a custom connector)
// cannot get the skill at all, because there is no release artifact in that
// path. Serving the skill from the server puts the manual next to the tools it
// documents, for every transport, with no second download.
//
// SHAPE. This follows SEP-2640 ("Skills over MCP"): a skill directory with a
// `SKILL.md` carrying `name`/`description` frontmatter, addressed as
// `skill://<name>/<path>`, with a catalogue that gives a SHA-256 digest per file
// so a host can verify what it loaded.
//
// WHAT IS DELIBERATELY NOT DONE. SEP-2640 also defines `skills/list` and
// `skills/get` methods behind an `io.modelcontextprotocol/skills` capability.
// That SEP is still an open draft, and `@modelcontextprotocol/server` 2.0.0 has
// no support for it: no `registerSkill`, no capability, nothing. Rather than
// hand-roll methods no client calls today, the same catalogue is served through
// `resources/list` + `resources/read`, which every current client already
// speaks. If and when the SEP lands, the `skills/*` methods become a thin
// adapter over exactly this data and the URIs do not change.
//
// COST. Nothing here is pushed at the model. Resources are pull-only, so an
// unused skill costs its `resources/list` metadata and not one token more,
// which is also the SEP's own position: the SDK "does not inject skill text into
// server instructions or tool descriptions", the host decides when to disclose.
import type { Server } from "./_shared.js";

/** Injected by esbuild (scripts/bundle.mjs) from scripts/collect-skills.mjs:
 * the whole skill tree as JSON, inlined because a `.mcpb` ships a single-file
 * server with no sibling assets to read at runtime. */
declare const __IWAC_SKILLS__: string;

/** MIME type for the catalogue document served at `skill://<name>`. */
const CATALOGUE_MIME = "application/json";

interface SkillFile {
  uri: string;
  path: string;
  mimeType: string;
  bytes: number;
  digest: string;
  title: string;
  summary: string;
  text: string;
}

interface Skill {
  name: string;
  description: string;
  entry: string;
  files: SkillFile[];
}

function loadCatalogue(): Skill[] {
  // In dev (tsx, no esbuild define) the constant is absent. Degrade to serving
  // no skills rather than crashing the server on a ReferenceError, the same
  // contract registerAppResources() uses for the chart HTML.
  if (typeof __IWAC_SKILLS__ !== "string") return [];
  try {
    return (JSON.parse(__IWAC_SKILLS__) as { skills: Skill[] }).skills ?? [];
  } catch {
    return [];
  }
}

/**
 * Register every skill file as an MCP resource, plus one catalogue per skill.
 *
 * The catalogue lives at the bare `skill://<name>`: authority only, no path.
 * That cannot collide with any file, because every file URI carries a non-empty
 * path, which is what makes the namespace safe to split this way.
 */
export function registerSkillResources(server: Server): void {
  for (const skill of loadCatalogue()) {
    const catalogueUri = `skill://${skill.name}`;

    // The catalogue mirrors a SEP-2640 `skills/list` entry: enough for a host to
    // decide whether the skill is relevant and to verify each file it then
    // reads, without having to read any of them first. `text` is stripped, because
    // the point of the catalogue is to avoid paying for content you have not asked
    // for.
    const catalogue = {
      name: skill.name,
      description: skill.description,
      entry: skill.entry,
      resources: skill.files.map(({ uri, path, mimeType, bytes, digest, title, summary }) => ({
        uri,
        path,
        mimeType,
        bytes,
        digest,
        title,
        summary,
      })),
    };

    server.registerResource(
      `skill-${skill.name}`,
      catalogueUri,
      {
        title: `${skill.name} (skill catalogue)`,
        description:
          `Catalogue of the '${skill.name}' Agent Skill served by this server: every file with its size and ` +
          `SHA-256 digest. Read ${skill.entry} for the skill itself; the reference files it names are ` +
          `resources under skill://${skill.name}/ and are meant to be read on demand, not upfront.`,
        mimeType: CATALOGUE_MIME,
      },
      async () => ({
        contents: [{ uri: catalogueUri, mimeType: CATALOGUE_MIME, text: JSON.stringify(catalogue) }],
      }),
    );

    for (const file of skill.files) {
      const isEntry = file.path === "SKILL.md";
      server.registerResource(
        `skill-${skill.name}-${file.path}`,
        file.uri,
        {
          title: isEntry ? `${skill.name} (SKILL.md)` : file.title || file.path,
          // The entry point is described by its own frontmatter, which is the
          // text a host matches a task against when deciding to activate a
          // skill. Supporting files get the summary derived from their lede.
          description: isEntry
            ? file.summary
            : `${skill.name} reference: ${file.summary || file.title || file.path}`,
          mimeType: file.mimeType,
        },
        async () => ({
          contents: [{ uri: file.uri, mimeType: file.mimeType, text: file.text }],
        }),
      );
    }
  }
}

/** Names of the skills this build serves, for the instructions block and tests. */
export function servedSkillNames(): string[] {
  return loadCatalogue().map((s) => s.name);
}
