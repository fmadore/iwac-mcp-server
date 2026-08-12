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
// THE METHODS. SEP-2640 also defines `skills/list` and `skills/get` behind an
// `io.modelcontextprotocol/skills` capability, and both are now served: the thin
// adapter over this same catalogue that an earlier revision of this comment
// predicted. That adapter was deferred on the reading that
// `@modelcontextprotocol/server` 2.0.0 "has no support for it: no
// `registerSkill`, no capability, nothing" — half right, and worth correcting
// here so the conclusion is not re-derived from the wrong premise. There is
// indeed no `registerSkill` and no dedicated skills capability. But
// `ServerCapabilities` models `extensions` as a generic record, and
// `setRequestHandler` takes arbitrary method names against a Standard Schema.
// Declaring the capability is therefore type-safe, and it MERGES with the
// tools/resources capabilities McpServer derives rather than replacing them.
//
// The `resources/*` path is unchanged, and is not a fallback for the methods:
// it is what every client speaks today, while `skills/*` is what a host
// implementing the draft looks for. Both read one catalogue, so they cannot
// disagree.
//
// WHAT IS DELIBERATELY NOT DONE. `resources/directory/read`, the extension's one
// OPTIONAL method, gated behind `directoryRead: true`. It cannot be added
// without breaking the namespace split below: the method enumerates directory
// resources, whose root here would be the bare `skill://<name>` — which is
// already the catalogue document. One URI cannot be both an `application/json`
// resource and an `inode/directory`. The capability is therefore declared as
// `{}` ("supported, no optional features"), which the SEP allows and which
// forbids a conformant host from calling the method. Nothing is lost:
// `skills/list` carries the complete file manifest, so directory walking is a
// convenience, not a discovery route. (The sibling amira-mcp-server makes the
// opposite trade: no catalogue document, bare URI as a directory, directoryRead
// on. Same SEP, one URI, two meanings — deliberate on both sides.)
//
// COST. Nothing here is pushed at the model. Resources are pull-only and the
// methods are called only by a host that asked, so an unused skill costs its
// `resources/list` metadata and not one token more,
// which is also the SEP's own position: the SDK "does not inject skill text into
// server instructions or tool descriptions", the host decides when to disclose.
import { INVALID_PARAMS, ProtocolError } from "@modelcontextprotocol/server";
import { z } from "zod";
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
  /** The whole SKILL.md frontmatter, verbatim, for the `skills/*` methods. */
  frontmatter: Record<string, unknown>;
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

/** Capability id negotiated for the draft extension. */
export const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";

/**
 * Capability block for `initialize` / `server/discover`.
 *
 * Empty on purpose: it advertises the two MANDATORY methods and withholds
 * `directoryRead`, which a conformant host reads as "do not call
 * `resources/directory/read`". See the header for why that method is out.
 */
export const SKILLS_CAPABILITY = { [SKILLS_EXTENSION_ID]: {} } as const;

/**
 * Whether this build actually carries a skill. Declaring the capability with an
 * empty catalogue would advertise methods that answer nothing, which is worse
 * than not advertising them: a host cannot tell "no skills" from "broken build".
 */
export function servesSkills(): boolean {
  return loadCatalogue().length > 0;
}

/**
 * The catalogue is fixed at build time, so every skill result is shareable
 * across clients for the same hour as `resources/list`. It travels in-band
 * because the SDK's `cacheHints` option is keyed by the closed set of spec
 * methods and cannot name an extension method.
 */
const SKILLS_CACHE_HINT = { ttlMs: 3_600_000, cacheScope: "public" } as const;

/** One SEP-2640 catalogue entry: what `skills/list` and `skills/get` both return. */
function skillEntry(skill: Skill): Record<string, unknown> {
  return {
    uri: skill.entry,
    frontmatter: skill.frontmatter,
    // Complete manifest, SKILL.md included: a host verifies every file it reads
    // against these digests and treats an unlisted file as a failure.
    resources: skill.files.map(({ uri, digest }) => ({ uri, digest })),
  };
}

const listParams = z.object({ cursor: z.string().optional() }).loose();
const uriParams = z.object({ uri: z.string() }).loose();
const anyResult = z.record(z.string(), z.unknown());

/**
 * Register the two mandatory SEP-2640 methods over the same catalogue the
 * resources are served from. The whole catalogue fits in one page, so no
 * `nextCursor` is emitted; `cursor` is accepted and ignored rather than
 * rejected, because a host that paginates by habit should not get an error.
 */
function registerSkillMethods(server: Server): void {
  const skills = loadCatalogue();
  if (skills.length === 0) return;
  const byUri = new Map(skills.map((skill) => [skill.entry, skill]));

  server.server.setRequestHandler("skills/list", { params: listParams, result: anyResult }, async () => ({
    skills: skills.map(skillEntry),
    ...SKILLS_CACHE_HINT,
  }));

  server.server.setRequestHandler("skills/get", { params: uriParams, result: anyResult }, async ({ uri }) => {
    const skill = byUri.get(uri);
    // The SEP names -32602 for a URI that identifies no served skill. A typo
    // must not resolve to something plausible-looking, the same contract
    // resources/read already holds.
    if (skill === undefined) throw new ProtocolError(INVALID_PARAMS, `Unknown skill: ${uri}`);
    return { skill: skillEntry(skill) };
  });
}

/**
 * Register every skill file as an MCP resource, plus one catalogue per skill,
 * plus the `skills/*` methods over the same data.
 *
 * The catalogue lives at the bare `skill://<name>`: authority only, no path.
 * That cannot collide with any file, because every file URI carries a non-empty
 * path, which is what makes the namespace safe to split this way.
 */
export function registerSkillResources(server: Server): void {
  registerSkillMethods(server);

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
