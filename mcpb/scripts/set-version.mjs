// Set the release version everywhere CI checks it, in one step:
//   mcpb/package.json, mcpb/package-lock.json, mcpb/manifest.json,
//   CITATION.cff (version and date-released) and the README "How to cite" block.
//
//   npm run set-version -- 5.0.0 [--date 2026-10-28]
//
// The CI version check (.github/workflows/ci.yml) still guards the result; this
// only removes the four hand edits that check exists to catch. The AMIRA server
// stamps its CITATION.cff from the tag instead; here the README quotes the
// version too, so every copy moves before the tag.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const version = args.find((arg) => /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(arg));
const dateFlag = args.indexOf("--date");
const date = dateFlag >= 0 ? args[dateFlag + 1] : new Date().toISOString().slice(0, 10);
if (!version || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) {
  console.error("usage: npm run set-version -- <major.minor.patch> [--date YYYY-MM-DD]");
  process.exit(2);
}

const at = (rel) => fileURLToPath(new URL(rel, import.meta.url));

/** Rewrite one file, refusing a pattern that no longer matches (a silent no-op
 * would leave that copy behind and fail CI after the tag). */
function rewrite(rel, edits) {
  const file = at(rel);
  let text = readFileSync(file, "utf8");
  for (const [pattern, replacement] of edits) {
    if (!pattern.test(text)) throw new Error(`${rel}: no match for ${pattern}`);
    text = text.replace(pattern, replacement);
  }
  writeFileSync(file, text);
}

function rewriteJson(rel, update) {
  const file = at(rel);
  const text = readFileSync(file, "utf8");
  const json = JSON.parse(text);
  update(json);
  writeFileSync(file, `${JSON.stringify(json, null, 2)}${text.endsWith("\n") ? "\n" : ""}`);
}

rewriteJson("../package.json", (pkg) => {
  pkg.version = version;
});
rewriteJson("../package-lock.json", (lock) => {
  lock.version = version;
  if (lock.packages?.[""]) lock.packages[""].version = version;
});
rewriteJson("../manifest.json", (manifest) => {
  manifest.version = version;
});
rewrite("../../CITATION.cff", [
  [/^version: .*$/m, `version: ${version}`],
  [/^date-released: .*$/m, `date-released: ${date}`],
]);
rewrite("../../README.md", [
  [/\(Version [\d.]+(?:-[\w.-]+)?\) \[Computer software\]/, `(Version ${version}) [Computer software]`],
  [/^(\s*version\s*=\s*\{)[\d.]+(?:-[\w.-]+)?(\},?\s*)$/m, `$1${version}$2`],
]);
console.log(`version ${version} (${date}) set in package.json, package-lock.json, manifest.json, CITATION.cff and README.md`);
