// Skills over MCP: serve the bundled Agent Skill through the finalized
// io.modelcontextprotocol/skills extension (SEP-2640, September 2026).
//
// skills/list and skills/get expose the same complete file manifest, including
// byte lengths and SHA-256 digests of the bytes returned by resources/read.
// Cache hints describe freshness; the manifest lets a host verify content.
// Both methods use the final extension's required response fields, rather than
// accepting an arbitrary record that can silently drift from the contract.
//
// Older clients can still discover and read the ordinary skill:// resources.
// Directory reading is optional and is not advertised: the bare skill://name
// URI remains our JSON catalogue for backwards compatibility. Every file has
// its own URI, so clients can load supporting references on demand.
// Specification: https://modelcontextprotocol.io/extensions/skills/overview
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

let catalogue: Skill[] | undefined;

/** The embedded skill tree, parsed once: it is ~110 kb of JSON and fixed at
 * build time, and createServer() consults it on every server it builds. */
function loadCatalogue(): Skill[] {
  catalogue ??= parseCatalogue();
  return catalogue;
}

function parseCatalogue(): Skill[] {
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

/** Capability id for the finalized Skills extension. */
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
function skillEntry(skill: Skill): z.infer<typeof skillSchema> {
  return {
    uri: skill.entry,
    frontmatter: { ...skill.frontmatter, name: skill.name, description: skill.description },
    // Complete manifest, SKILL.md included: a host verifies every file it reads
    // against these digests and treats an unlisted file as a failure.
    resources: skill.files.map(({ uri, digest, bytes }) => ({ uri, digest, size: bytes })),
  };
}

const listParams = z.object({ cursor: z.string().optional() }).loose();
const uriParams = z.object({ uri: z.string() }).loose();
// Unknown future metadata is permitted, but required contract fields are not.
const skillSchema = z.looseObject({
  uri: z.string(),
  frontmatter: z.looseObject({ name: z.string(), description: z.string() }),
  resources: z.array(z.looseObject({
    uri: z.string(),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    size: z.number().int().nonnegative(),
  })),
});
const cacheFields = {
  resultType: z.literal("complete"),
  ttlMs: z.number().int().nonnegative(),
  cacheScope: z.enum(["public", "private"]),
};
const listResult = z.looseObject({ ...cacheFields, skills: z.array(skillSchema) });
const getResult = z.looseObject({ ...cacheFields, skill: skillSchema });

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

  server.server.setRequestHandler("skills/list", { params: listParams, result: listResult }, async () => ({
    resultType: "complete" as const,
    skills: skills.map(skillEntry),
    ...SKILLS_CACHE_HINT,
  }));

  server.server.setRequestHandler("skills/get", { params: uriParams, result: getResult }, async ({ uri }) => {
    const skill = byUri.get(uri);
    // The SEP names -32602 for a URI that identifies no served skill. A typo
    // must not resolve to something plausible-looking, the same contract
    // resources/read already holds.
    if (skill === undefined) throw new ProtocolError(INVALID_PARAMS, `Unknown skill: ${uri}`);
    return { resultType: "complete" as const, skill: skillEntry(skill), ...SKILLS_CACHE_HINT };
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
