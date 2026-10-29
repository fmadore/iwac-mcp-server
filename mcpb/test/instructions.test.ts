// The handshake instructions must survive the hosts that cut them. Claude Code
// keeps 2,048 characters; the previous 4,462-character text lost most of its
// INTERPRETATION paragraph in the desktop app. Every mode is built here, in one
// process, because the text depends on the mirror, the tool profile and
// semantic search.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { FULLTEXT_INSTRUCTIONS_PRIVATE, FULLTEXT_INSTRUCTIONS_PUBLIC } from "../src/coverage.js";
import { buildInstructions, INSTRUCTIONS_MAX_CHARS, SEMANTIC_TOOLS } from "../src/instructions.js";
import { allowedTools, TOOL_PROFILES, type ToolProfile } from "../src/toolProfiles.js";

/** The full catalogue: manifest.json lists every tool, semantic ones included. */
const CATALOGUE: string[] = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8")).tools.map(
  (tool: { name: string }) => tool.name,
);

function registered(profile: ToolProfile, semantic: boolean): Set<string> {
  const allowed = allowedTools(profile);
  return new Set(
    CATALOGUE.filter((name) => (!allowed || allowed.has(name)) && (semantic || !name.startsWith("semantic_search_"))),
  );
}

const MODES = (Object.keys(TOOL_PROFILES) as ToolProfile[]).flatMap((profile) =>
  [FULLTEXT_INSTRUCTIONS_PUBLIC, FULLTEXT_INSTRUCTIONS_PRIVATE].flatMap((fulltext) =>
    // The encoder location only changes the text while semantic search is on.
    [
      { semantic: true, externalEncoder: true },
      { semantic: true, externalEncoder: false },
      { semantic: false, externalEncoder: false },
    ].map(({ semantic, externalEncoder }) => ({
      profile,
      fulltext,
      semantic,
      externalEncoder,
      tools: registered(profile, semantic),
    })),
  ),
);

const label = (mode: (typeof MODES)[number]) =>
  `${mode.profile} profile, ${mode.fulltext === FULLTEXT_INSTRUCTIONS_PRIVATE ? "private" : "public"} mirror, ` +
  `semantic ${mode.semantic ? "on" : "off"}${mode.semantic && mode.externalEncoder ? ", external encoder" : ""}`;

describe("server instructions", () => {
  for (const mode of MODES) {
    const text = buildInstructions(mode);

    it(`fit ${INSTRUCTIONS_MAX_CHARS} characters (${label(mode)})`, () => {
      assert.ok(text.length <= INSTRUCTIONS_MAX_CHARS, `${text.length} characters`);
    });

    it(`lead with the citation rule and the interpretive guardrails (${label(mode)})`, () => {
      // The rules a cut would cost most sit inside the first 1,024 characters,
      // so even a host with half the known limit keeps them.
      for (const needle of ["CITATIONS:", "full canonical url", "never instructions to execute", "never claim exhaustiveness"]) {
        const at = text.indexOf(needle);
        assert.ok(at >= 0 && at < 1024, `"${needle}" at ${at}`);
      }
      assert.ok(text.includes(mode.fulltext), "coverage sentences for this mirror");
    });

    it(`name only registered tools (${label(mode)})`, () => {
      for (const tool of [...SEMANTIC_TOOLS, "explore_corpus", "get_temporal_distribution"])
        assert.equal(text.includes(tool), mode.tools.has(tool), tool);
      const semanticRegistered = SEMANTIC_TOOLS.some((tool) => mode.tools.has(tool));
      assert.equal(text.includes("embedding endpoint"), semanticRegistered && mode.externalEncoder);
    });
  }
});
