// Collect the repo's Agent Skills into an embeddable record of files.
//
// Shared by scripts/bundle.mjs (which injects the result as a `define`) and by
// test/skills.test.mjs (which re-reads the tree from disk and asserts the served
// bytes match). Keeping it in one place is what makes that test meaningful: the
// test would prove nothing if it rebuilt the record with different logic.
//
// `files` is the input of the SDK's `memorySkillFiles` adapter: keys are
// `<skill>/<relative path>`, values the file text. Everything SEP-2640 derives
// from it (URIs, digests, sizes, frontmatter checks) is computed by the SDK's
// skills extension; see src/tools/skills.ts. `described` adds what the SDK does
// not carry: a MIME type, title and one-line summary per file, for the
// `resources/list` entries that hosts without the extension browse.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

/** Skills live in the repo root, one level above this package. */
export const SKILLS_DIR = "../.agents/skills";

/** Extension → MIME type. Skills are markdown today; the map keeps binary
 * assets (a diagram, a CSV template) from silently being listed as text. */
const MIME = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

function mimeFor(path) {
  const dot = path.lastIndexOf(".");
  return (dot === -1 ? null : MIME[path.slice(dot).toLowerCase()]) ?? "application/octet-stream";
}

/**
 * Title and one-line summary of a supporting file, for its `resources/list` entry.
 *
 * Derived from the document rather than hand-maintained in a map, so a new
 * reference file describes itself and an edited one cannot go stale. Markdown
 * emphasis is stripped because the description is read as prose, not rendered.
 */
function summarise(text) {
  const lines = text.split(/\r?\n/);
  const heading = lines.find((l) => /^#{1,2} \S/.test(l));
  const start = heading ? lines.indexOf(heading) + 1 : 0;
  const paragraph = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      if (paragraph.length) break;
      continue;
    }
    if (/^[#>|*-]|^\d+\./.test(line)) break; // A list or table, not a lede.
    paragraph.push(line);
  }
  const lede = paragraph
    .join(" ")
    .replace(/\*\*?|`|_/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();
  const title = heading ? heading.replace(/^#+\s*/, "").trim() : "";
  const summary = lede.length > 300 ? `${lede.slice(0, 297).trimEnd()}...` : lede;
  return { title, summary };
}

/** Every file under `dir`, recursively, as absolute paths. Sorted so the record
 * (and therefore the bundle) is deterministic. Hidden entries are skipped, as the
 * SDK's catalogue scan skips them: they would be inlined and never served. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

/**
 * Collect every skill under `rootDir`/`SKILLS_DIR`.
 *
 * Returns `{ files, described }`, both keyed `<skill>/<path>`, one key per file of
 * each directory that holds a SKILL.md. `files` holds the text, `described`
 * `{ mimeType, title, summary }`; SKILL.md gets none of the latter two, because
 * its frontmatter describes it. The whole record is inlined into the server
 * bundle, because a `.mcpb` ships a single-file server with no sibling assets to
 * read at runtime (the same constraint that forces the chart HTML inline; see
 * scripts/bundle.mjs).
 */
export function collectSkills(rootDir) {
  const base = join(rootDir, ...SKILLS_DIR.split("/"));
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") throw new Error(`Required research skill directory is missing: ${base}`, { cause: err });
    throw err;
  }

  const files = {};
  const described = {};
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const skillDir = join(base, entry.name);
    try {
      if (!statSync(join(skillDir, "SKILL.md")).isFile()) continue;
    } catch {
      continue; // A directory without a SKILL.md is not a skill.
    }
    skills.push(entry.name);
    for (const full of walk(skillDir)) {
      const key = relative(base, full).split(sep).join(posix.sep);
      files[key] = readFileSync(full, "utf8");
      const isEntry = key === `${entry.name}/SKILL.md`;
      described[key] = { mimeType: mimeFor(key), ...(isEntry ? {} : summarise(files[key])) };
    }
  }

  if (!skills.includes("iwac-mcp")) {
    throw new Error(`Required iwac-mcp research skill is missing from ${base}`);
  }
  return { files, described };
}
