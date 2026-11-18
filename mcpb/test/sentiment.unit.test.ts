// Unit tests for the sentiment model registry (generation 2): model ids,
// aliases, retired ids, consensus columns and the subjectivity scale. Split
// from the former test/unit.test.ts (November 2026); `npm run test:unit` runs
// it (tsx --test).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SENTIMENT_MODEL,
  resolveSentimentModel,
  SENTIMENT_MODELS,
  CONSENSUS_COLS,
  CONSENSUS_DISPUTE_COL,
  DISPUTE_FIELDS,
  retiredSentimentModel,
  SENTIMENT_MODEL_IDS,
  sentimentCols,
  subjectivityRank,
  SUBJECTIVITY_VALUES,
} from "../src/tools/_shared.js";

describe("sentiment model registry (generation 2)", () => {
  it("resolves a model by its raw column prefix as documented", () => {
    for (const m of SENTIMENT_MODELS) {
      assert.equal(resolveSentimentModel(m.prefix)?.id, m.id, `${m.prefix} should resolve`);
    }
  });

  it("serves the six generation-2 models and builds their column names", () => {
    assert.deepEqual(SENTIMENT_MODEL_IDS, [
      "gpt-5-6-luna",
      "mistral-small-2603",
      "deepseek-v4-flash-0731",
      "gemma-4-31b-it",
      "qwen3-8-27b",
      "claude-haiku-5-5",
    ]);
    const deepseek = resolveSentimentModel("deepseek");
    assert.ok(deepseek, "deepseek should resolve");
    const cols = sentimentCols(deepseek);
    assert.equal(cols.polarity, "deepseek_v4_flash_0731_polarite");
    assert.equal(cols.centrality, "deepseek_v4_flash_0731_centralite_islam_musulmans");
    assert.equal(cols.subjectivity, "deepseek_v4_flash_0731_subjectivite_score");
    const gemma = resolveSentimentModel("gemma-4-31b-it");
    assert.ok(gemma, "gemma should resolve");
    assert.equal(sentimentCols(gemma).polarity, "gemma_4_31b_it_polarite");
    assert.equal(sentimentCols(gemma).subjectivity, "gemma_4_31b_it_subjectivite_score");
    const qwen = resolveSentimentModel("qwen3-8-27b");
    assert.ok(qwen, "qwen should resolve");
    assert.equal(sentimentCols(qwen).polarity, "qwen3_8_27b_polarite");
    assert.equal(sentimentCols(qwen).centrality, "qwen3_8_27b_centralite_islam_musulmans");
    assert.equal(sentimentCols(qwen).subjectivity, "qwen3_8_27b_subjectivite_score");
    const haiku = resolveSentimentModel("claude-haiku-5-5");
    assert.ok(haiku, "haiku should resolve");
    assert.equal(sentimentCols(haiku).polarity, "claude_haiku_5_5_polarite");
    assert.equal(sentimentCols(haiku).centrality, "claude_haiku_5_5_centralite_islam_musulmans");
    assert.equal(sentimentCols(haiku).subjectivity, "claude_haiku_5_5_subjectivite_score");
  });

  // qwen3-8-27b falls short of the corpus and claude-haiku-5-5 reaches past
  // it. The registry is where both are recorded, so a caller comparing their
  // counts with another model's is told why they do not share a denominator —
  // and the other four, which share one, must NOT carry a caveat that would
  // dilute them.
  it("carries a coverage caveat on qwen and haiku alone", () => {
    const qwen = resolveSentimentModel("qwen3-8-27b");
    assert.match(qwen?.caveat ?? "", /12,098/);
    const haiku = resolveSentimentModel("claude-haiku-5-5");
    // Both halves matter: the single-rater rows AND the missing pilot.
    assert.match(haiku?.caveat ?? "", /16,617/);
    assert.match(haiku?.caveat ?? "", /no consensus/);
    assert.match(haiku?.caveat ?? "", /pilot/);
    for (const id of ["gpt-5-6-luna", "mistral-small-2603", "deepseek-v4-flash-0731", "gemma-4-31b-it"]) {
      assert.equal(resolveSentimentModel(id)?.caveat, undefined, `${id} covers the corpus and needs no caveat`);
    }
  });

  // The default moved once, to Haiku in v6.0.0, for reach (it alone has read
  // the newest arrivals). Moving it re-labels every inline value while the
  // payload shape stays the same, so it must only move on purpose: this pins
  // it, and pins that it is chosen by id rather than by panel position.
  it("uses claude-haiku-5-5 as the single-model default, chosen by id", () => {
    assert.equal(DEFAULT_SENTIMENT_MODEL.id, "claude-haiku-5-5");
    assert.equal(sentimentCols(DEFAULT_SENTIMENT_MODEL).polarity, "claude_haiku_5_5_polarite");
    assert.notEqual(SENTIMENT_MODEL_IDS[0], DEFAULT_SENTIMENT_MODEL.id, "the panel order stays chronological");
  });

  it("resolves ids, vendor shorthand and raw column prefixes alike", () => {
    for (const handle of ["gpt-5-6-luna", "GPT_5_6_Luna", " gpt 5 6 luna ", "chatgpt", "openai"]) {
      assert.equal(resolveSentimentModel(handle)?.id, "gpt-5-6-luna", handle);
    }
    assert.equal(resolveSentimentModel("mistral_small_2603")?.id, "mistral-small-2603");
    // `google` is a VENDOR shorthand, so it lands on that vendor's generation-2
    // member exactly as `mistral` and `chatgpt` do — see the `gemini` case below
    // for the line this does not cross.
    for (const handle of ["gemma", "gemma_4_31b_it", "google", "GOOGLE"]) {
      assert.equal(resolveSentimentModel(handle)?.id, "gemma-4-31b-it", handle);
    }
    // `qwen` names the model LINE this member belongs to, so unlike `gemini` it
    // resolves: the line itself scored generation 2. `alibaba` is the vendor.
    for (const handle of ["qwen", "qwen3_8_27b", "alibaba", "QWEN"]) {
      assert.equal(resolveSentimentModel(handle)?.id, "qwen3-8-27b", handle);
    }
    // Anthropic has one panel member, so the vendor, the product and the
    // model line all name it.
    for (const handle of ["claude", "anthropic", "haiku", "claude_haiku_5_5", "Claude Haiku 5 5"]) {
      assert.equal(resolveSentimentModel(handle)?.id, "claude-haiku-5-5", handle);
    }
  });

  // The load-bearing one. A generation-1 id must not quietly land on the same
  // vendor's generation-2 model: they scored the corpus differently, so the
  // answer would be right-shaped and wrong. `gemini` is the sharpest case —
  // Google DOES have a generation-2 member now, but it is Gemma, a different
  // model line, so the handle stays refused rather than being re-pointed.
  it("refuses retired handles instead of re-pointing them at a successor", () => {
    for (const retired of ["gpt-5-mini", "gemini-3-flash-preview", "ministral-14b-2512", "gemini", "ministral"]) {
      assert.equal(resolveSentimentModel(retired), undefined, `${retired} must not resolve`);
      assert.ok(retiredSentimentModel(retired), `${retired} must explain itself`);
    }
    assert.match(retiredSentimentModel("gemini") ?? "", /gemma-4-31b-it/);
    assert.equal(retiredSentimentModel("llama"), undefined); // never a model here, so just unknown
  });

  // The consensus is a DERIVED aggregate, not an annotator. Letting it resolve
  // as a model would put a value no model produced into a `model` field that
  // everywhere else names the exact model that judged — the same ambiguity the
  // vendor-prefix rename was meant to end.
  it("keeps the consensus out of the model registry", () => {
    for (const handle of ["consensus", "consensus_polarite", "panel", "majority"]) {
      assert.equal(resolveSentimentModel(handle), undefined, `${handle} must not resolve to a model`);
    }
    assert.ok(!SENTIMENT_MODEL_IDS.includes("consensus"));
    // It is also not a RETIRED handle: retired means "named a real annotator
    // once", and nothing ever annotated under this name.
    assert.equal(retiredSentimentModel("consensus"), undefined);
  });

  // The three consensus fields do not share a shape, and the subjectivity one is
  // the trap: a float median on the same 1-5 scale the labels rank to, so it
  // looks joinable to SUBJECTIVITY_VALUES and is not.
  it("names the consensus columns and their dispute vocabulary", () => {
    assert.deepEqual(CONSENSUS_COLS, {
      polarity: "consensus_g2_polarite",
      centrality: "consensus_g2_centralite",
      subjectivity: "consensus_g2_subjectivite_score",
    });
    assert.equal(CONSENSUS_DISPUTE_COL, "sentiment_g2_disagreement");
    // French, matching the stored values rather than this server's English
    // parameter names — the filter matches on these verbatim.
    assert.deepEqual([...DISPUTE_FIELDS], ["polarite", "centralite", "subjectivite"]);
    for (const f of DISPUTE_FIELDS) {
      assert.equal(subjectivityRank(f), undefined, `${f} must not be mistaken for a subjectivity label`);
    }
  });

  it("ranks the subjectivity labels 1-5 and nothing else", () => {
    assert.deepEqual(SUBJECTIVITY_VALUES.map(subjectivityRank), [1, 2, 3, 4, 5]);
    assert.equal(subjectivityRank(" Mixte "), 3);
    for (const bad of ["", "2", "Non abordé", "Très positif"]) assert.equal(subjectivityRank(bad), undefined, bad);
  });
});
