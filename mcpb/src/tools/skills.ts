// Skills over MCP: serve the bundled Agent Skill through the SDK's
// io.modelcontextprotocol/skills extension (SEP-2640).
//
// The SDK owns the protocol. `SkillsExtension.load()` builds each skill's entry
// (sizes, SHA-256 digests, frontmatter and publication-limit checks), and the
// extension serves `skills/list`, `skills/get`, `resources/directory/read` and
// the `skill://{+path}` resource template, and declares the capability
// (`directoryRead` included) when attached.
//
// One thing the SDK's own catalogue does not do is list every file: it puts one
// entry per skill in resources/list. Hosts without the extension (Claude Desktop,
// Claude Code) find files there, and SKILL.md names its references by relative
// path, so the references would become invisible to them. The catalogue is
// therefore served through a small `SkillSource` over the SDK-built entries,
// whose `listResources()` lists every file with a title and summary. The bare
// `skill://<name>` URI is the skill's directory, as in the SDK's catalogue.
// Specification: https://modelcontextprotocol.io/extensions/skills/overview
import type { McpServer, Resource } from "@modelcontextprotocol/server";
import {
  DIRECTORY_MIME_TYPE,
  memorySkillFiles,
  type Skill,
  type SkillSource,
  SkillsExtension,
} from "@modelcontextprotocol/server/ext/skills";

/** Injected by esbuild (scripts/bundle.mjs) from scripts/collect-skills.mjs,
 * inlined because a `.mcpb` ships a single-file server with no sibling assets to
 * read at runtime. Both records are keyed `<skill>/<path>`. */
declare const __IWAC_SKILLS__: string;

interface Embedded {
  files: Record<string, string>;
  described: Record<string, { mimeType: string; title?: string; summary?: string }>;
}

const BASE = "skill://";

/**
 * The catalogue is fixed at build time, so every skill result is shareable
 * across clients for the same hour as `resources/list`.
 */
const SKILLS_CACHE_HINT = { ttlMs: 3_600_000, cacheScope: "public" } as const;

/** A skill's root directory URI: its SKILL.md URI without the file name. */
const rootOf = (skill: Skill) => skill.uri.slice(0, -"/SKILL.md".length);

/** The files an entry's manifest names. Ours are never `"dynamic"`. */
const manifestOf = (skill: Skill) => (Array.isArray(skill.resources) ? skill.resources : []);

/**
 * Serve the SDK-built entries from the embedded files.
 *
 * Reads need no re-verification here: the entries were computed from these very
 * strings, which are constants of the bundle. Anything outside a manifest is
 * answered as absent, so a typo cannot resolve to something plausible-looking.
 */
function embeddedSource(entries: readonly Skill[], { files, described }: Embedded): SkillSource {
  const byUri = new Map(entries.map((skill) => [skill.uri, skill]));
  const served = new Map<string, string>();
  const directories = new Map<string, Resource[]>();
  const listed: Resource[] = [];

  for (const skill of entries) {
    const name = skill.frontmatter.name;
    for (const { uri, size } of manifestOf(skill)) {
      const path = uri.slice(BASE.length);
      const { mimeType, title, summary } = described[path] ?? { mimeType: "text/markdown" };
      served.set(uri, path);

      // Every directory from the skill's root down to the file gains a child.
      const segments = uri.slice(rootOf(skill).length + 1).split("/");
      let dir = rootOf(skill);
      segments.forEach((segment, i) => {
        const child = `${dir}/${segment}`;
        const children = directories.get(dir) ?? [];
        directories.set(dir, children);
        if (!children.some((c) => c.uri === child)) {
          const isFile = i === segments.length - 1;
          children.push(
            isFile ? { uri: child, name: segment, mimeType, size } : { uri: child, name: segment, mimeType: DIRECTORY_MIME_TYPE },
          );
        }
        dir = child;
      });

      // The entry point is described by its own frontmatter, which is the text a
      // host matches a task against when deciding to activate a skill. Supporting
      // files get the summary derived from their lede.
      const isEntry = uri === skill.uri;
      listed.push({
        uri,
        name: isEntry ? name : path,
        title: isEntry ? `${name} (SKILL.md)` : title || path,
        description: isEntry ? skill.frontmatter.description : `${name} reference: ${summary || title || path}`,
        mimeType,
        size,
      });
    }
  }
  for (const children of directories.values()) children.sort((a, b) => a.uri.localeCompare(b.uri));

  return {
    // One page: the whole catalogue is a single skill.
    list: async () => ({ skills: [...entries] }),
    get: async (uri) => byUri.get(uri),
    read: async (uri) => {
      const path = served.get(uri);
      if (path === undefined) return undefined;
      return { text: files[path] ?? "", mimeType: described[path]?.mimeType };
    },
    readDirectory: async (uri) => {
      const children = directories.get(uri);
      return children === undefined ? undefined : { resources: children };
    },
    listResources: async () => listed,
  };
}

/**
 * Build the extension from the embedded files.
 *
 * `strict` turns a skill the SDK would skip with a warning into an error. The
 * bundler has already loaded the same files under the same options, so a bad
 * skill fails the build, not a user's server. Should it fail here anyway, the
 * server keeps its tools and serves no skills, the same contract
 * registerAppResources() uses for the chart HTML. In dev (tsx, no esbuild
 * define) the constant is absent and there is nothing to serve.
 */
async function loadSkills(): Promise<SkillsExtension | undefined> {
  if (typeof __IWAC_SKILLS__ !== "string") return undefined;
  try {
    const embedded = JSON.parse(__IWAC_SKILLS__) as Embedded;
    if (Object.keys(embedded.files).length === 0) return undefined;
    const { entries } = await SkillsExtension.load(memorySkillFiles(embedded.files), { strict: true });
    return new SkillsExtension({
      source: embeddedSource(entries, embedded),
      cacheHint: SKILLS_CACHE_HINT,
      strict: true,
    });
  } catch (err) {
    console.error("[iwac] skills not served:", err);
    return undefined;
  }
}

// `load()` is async and the server factory is not, so the extension is built
// once, before the first server exists. One instance serves every server the
// factory builds, per stdio connection or per HTTP request.
const skills = await loadSkills();

/**
 * Serve the skill on `server`: resources, `skills/*` methods and capability.
 * Not part of the recorded registrations (tools/register.ts), because the SDK
 * wires the extension onto a real server rather than through `Server`.
 */
export function attachSkills(server: McpServer): void {
  // `attach` is @experimental: its wiring may change in a minor SDK release,
  // which is why package.json pins the SDK's minor and test/skills.test.mjs
  // checks the whole contract end to end.
  skills?.attach(server);
}
