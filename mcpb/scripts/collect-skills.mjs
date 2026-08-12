// Collect the repo's Agent Skills into an embeddable catalogue.
//
// Shared by scripts/bundle.mjs (which injects the result as a `define`) and by
// test/skills.test.mjs (which re-reads the tree from disk and asserts the served
// bytes match). Keeping it in one place is what makes that test meaningful: the
// test would prove nothing if it rebuilt the catalogue with different logic.
//
// Shape follows SEP-2640 ("Skills over MCP", still a draft PR against the spec):
// a skill is a directory holding a `SKILL.md` with `name` + `description`
// frontmatter, plus arbitrary supporting files. Each file is addressed as
// `skill://<skill-name>/<relative-path>` and carries a SHA-256 digest so a host
// can verify what it loaded. See src/tools/skills.ts for why this ships as
// plain resources rather than the SEP's `skills/list` / `skills/get` methods.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

/** Skills live in the repo root, one level above this package. */
export const SKILLS_DIR = "../.agents/skills";

/** Extension → MIME type. Skills are markdown today; the map keeps binary
 * assets (a diagram, a CSV template) from silently being served as text. */
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

/** Every file under `dir`, recursively, as repo-relative POSIX paths. Sorted so
 * the catalogue (and therefore the bundle and its digests) is deterministic. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

/**
 * Parse the leading YAML frontmatter of a SKILL.md.
 *
 * Deliberately NOT a YAML parser: the frontmatter contract is two scalar keys
 * (`name`, `description`), where `description` is routinely a `|` block spanning
 * a dozen lines. Pulling in a YAML dependency to read two keys at build time
 * would be the tail wagging the dog. Anything richer than that is ignored
 * rather than mis-parsed, and a missing `name`/`description` throws.
 */
function parseFrontmatter(text, path) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!match) throw new Error(`${path}: no YAML frontmatter block`);

  const fields = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const value = rawValue.trim();
    // Block scalar (`|`, `>`, with optional chomping indicator): consume the
    // following more-indented lines.
    if (/^[|>][-+]?$/.test(value)) {
      const block = [];
      while (i + 1 < lines.length && (lines[i + 1].trim() === "" || /^\s/.test(lines[i + 1]))) {
        block.push(lines[++i].replace(/^ {1,4}/, ""));
      }
      fields[key] = block.join("\n").trim();
    } else {
      fields[key] = value.replace(/^["']|["']$/g, "");
    }
  }

  for (const required of ["name", "description"]) {
    if (!fields[required]) throw new Error(`${path}: frontmatter is missing '${required}'`);
  }
  return fields;
}

/**
 * One-line summary of a supporting file, for its `resources/list` entry.
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

/**
 * Build the catalogue of every skill under `rootDir`/`SKILLS_DIR`.
 *
 * Returns `{ skills: [{ name, description, frontmatter, entry, files: [...] }] }`,
 * where each file carries `{ uri, path, mimeType, bytes, digest, text }`. `text` is the
 * file content; the server bundle inlines it, because a `.mcpb` ships a
 * single-file server with no sibling assets to read at runtime (the same
 * constraint that forces the chart HTML inline; see scripts/bundle.mjs).
 */
export function collectSkills(rootDir) {
  const base = join(rootDir, ...SKILLS_DIR.split("/"));
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return { skills: [] };
    throw err;
  }

  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(base, entry.name);
    const skillMd = join(skillDir, "SKILL.md");
    try {
      if (!statSync(skillMd).isFile()) continue;
    } catch {
      continue; // A directory without a SKILL.md is not a skill.
    }

    const front = parseFrontmatter(readFileSync(skillMd, "utf8"), `${entry.name}/SKILL.md`);
    // The frontmatter name is authoritative for the URI: it is what the host
    // installs the skill as, and a mismatch with the directory would make
    // `skill://<name>/...` unresolvable against the catalogue.
    if (front.name !== entry.name) {
      throw new Error(`${entry.name}/SKILL.md: frontmatter name '${front.name}' does not match its directory`);
    }

    const files = walk(skillDir).map((full) => {
      const rel = relative(skillDir, full).split(sep).join(posix.sep);
      const text = readFileSync(full, "utf8");
      // SKILL.md is described by its own frontmatter, because that text is the skill's
      // activation contract and is what a host matches a task against. Only the
      // supporting files get a derived summary.
      const described = rel === "SKILL.md" ? { title: front.name, summary: front.description } : summarise(text);
      return {
        uri: `skill://${front.name}/${rel}`,
        path: rel,
        mimeType: mimeFor(rel),
        bytes: Buffer.byteLength(text),
        digest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
        ...described,
        text,
      };
    });

    skills.push({
      name: front.name,
      description: front.description,
      // The WHOLE parsed frontmatter, not just the two required keys. A host
      // verifying a SEP-2640 `skills/list` entry re-reads SKILL.md and compares
      // frontmatter field by field; reporting a subset would read as a
      // discrepancy the moment anyone adds a `license:` or `compatibility:`
      // line. `name`/`description` stay hoisted because the catalogue document
      // and the instructions block index on them.
      frontmatter: front,
      entry: `skill://${front.name}/SKILL.md`,
      files,
    });
  }

  return { skills: skills.sort((a, b) => a.name.localeCompare(b.name)) };
}
