// Pure helpers behind the v5 tool contract: keyword terms, error codes, the
// input string bound, tool profiles and the compact provenance summary.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { errorResult, extractMatchingTocEntries, inferErrorCode, keywordTerms, MAX_KEYWORD_TERMS } from "../src/tools/_shared.js";
import { MAX_INPUT_STRING_CHARS, overlongString } from "../src/tools/register.js";
import { allowedTools, resolveToolProfile, TOOL_PROFILES } from "../src/toolProfiles.js";
import { provenanceSummary } from "../src/provenance.js";

describe("keywordTerms", () => {
  it("requires every word by default and keeps quoted phrases whole", () => {
    assert.deepEqual(keywordTerms("pèlerinage  Mecque"), ["pèlerinage", "Mecque"]);
    assert.deepEqual(keywordTerms('"La Mecque" hadj'), ["La Mecque", "hadj"]);
    assert.deepEqual(keywordTerms('  "  "  '), []);
    assert.deepEqual(keywordTerms(undefined), []);
  });
  it("keeps the old single substring as literal, and all_terms ignores quotes", () => {
    assert.deepEqual(keywordTerms(" pèlerinage Mecque ", "literal"), ["pèlerinage Mecque"]);
    assert.deepEqual(keywordTerms('"La Mecque"', "all_terms"), ['"La', 'Mecque"']);
  });
  it("reads a one-word keyword the same way in every mode", () => {
    for (const mode of [undefined, "literal", "all_terms"] as const) assert.deepEqual(keywordTerms("Tabaski", mode), ["Tabaski"]);
  });
  it("bounds the number of terms through the filters that use it", () => {
    assert.equal(MAX_KEYWORD_TERMS, 12);
  });
});

describe("error codes", () => {
  it("infers a stable code from the message", () => {
    assert.equal(inferErrorCode("No articles item with id '9'."), "not_found");
    assert.equal(inferErrorCode("Index entry 4 not found"), "not_found");
    assert.equal(inferErrorCode("Subset 'images' has no pub_date column in this dataset revision"), "unavailable");
    assert.equal(inferErrorCode("Semantic search is not enabled (IWAC_SEMANTIC_SEARCH_ENABLED=false)."), "unavailable");
    assert.equal(inferErrorCode("Item 5 has an invalid or zero embedding"), "data_error");
    assert.equal(inferErrorCode("date_from is after date_to"), "invalid_argument");
  });
  it("adds the code without changing the existing fields, and an explicit code wins", () => {
    const body = JSON.parse(errorResult({ error: "Invalid country: Mali", valid_values: ["Benin"] }).content[0].text);
    assert.deepEqual(body, { code: "invalid_argument", error: "Invalid country: Mali", valid_values: ["Benin"] });
    assert.equal(JSON.parse(errorResult({ error: "whatever" }, "unavailable").content[0].text).code, "unavailable");
  });
});

describe("input string bound", () => {
  it("finds the path of the first overlong string, nested or not", () => {
    const long = "x".repeat(MAX_INPUT_STRING_CHARS + 1);
    assert.equal(overlongString({ keyword: "ok" }), undefined);
    assert.equal(overlongString({ keyword: long }), "keyword");
    assert.equal(overlongString({ selection: { keyword_aliases: ["a", long] } }), "selection.keyword_aliases[1]");
    assert.equal(overlongString({ keyword: "x".repeat(MAX_INPUT_STRING_CHARS) }), undefined);
  });
});

describe("tool profiles", () => {
  it("resolves names case-insensitively, defaults to full and refuses typos", () => {
    assert.equal(resolveToolProfile(undefined), "full");
    assert.equal(resolveToolProfile(" Core "), "core");
    assert.throws(() => resolveToolProfile("analytics"), /IWAC_TOOL_PROFILE/);
  });
  it("keeps the cross-subset entry pair in every profile", () => {
    for (const profile of Object.keys(TOOL_PROFILES) as (keyof typeof TOOL_PROFILES)[]) {
      const allowed = allowedTools(profile);
      if (allowed) for (const tool of ["search", "fetch"]) assert.ok(allowed.has(tool), `${profile} lacks ${tool}`);
    }
  });
});

describe("provenance summary", () => {
  const full = {
    snapshot_id: "a".repeat(64),
    analysis_version: "iwac-research-v3",
    tool: "search",
    arguments: { query: "x" },
    datasets: {
      articles: { repository: "r", revision: "main", access: "public", files: [{ path: "p", identity: "sha256:1" }], freshness: "verified against Hub file identities" },
      index: { repository: "r", revision: "main", access: "public", files: [], freshness: "cached; refresh failed" },
    },
  };
  it("keeps the snapshot id, revision, access and subsets, and flags unverified subsets only", () => {
    assert.deepEqual(provenanceSummary(full), {
      snapshot_id: "a".repeat(64),
      revision: "main",
      access: "public",
      subsets: ["articles", "index"],
      freshness: { index: "cached; refresh failed" },
    });
  });
  it("names the embedding model of a semantic query", () => {
    assert.equal(provenanceSummary({ ...full, embedding_contract: { model: "google/embeddinggemma-2" } }).embedding_model, "google/embeddinggemma-2");
  });
});

describe("matching table-of-contents entries", () => {
  it("returns the entries holding any required term", () => {
    const toc = "Le pèlerinage\n\nLa Mecque\n\nAutre";
    assert.equal(extractMatchingTocEntries(toc, ["pèlerinage", "Mecque"]), "Le pèlerinage\n\nLa Mecque");
    assert.equal(extractMatchingTocEntries(toc, "autre"), "Autre");
  });
});
