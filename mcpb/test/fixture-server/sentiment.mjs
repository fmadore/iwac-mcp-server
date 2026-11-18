// Fixture-server checks for the cross-model sentiment panel: per-model and
// consensus distributions, disputed filters and refused model ids. Called in
// order by test/fixture-server.test.mjs.

/** Runs on the shared legacy-era client, in file order. */
export async function sentimentChecks({ call }) {
  // Cross-model sentiment: the whole panel, and how far it agrees. Every model
  // identifier here is the EXACT generation-2 model that scored the corpus,
  // because a polarity share is meaningless without knowing what produced it.
  await call("get_sentiment_distribution", { model: "all" }, {
    structured: true,
    check: (p) => {
      if (String(p.models) !== "gpt-5-6-luna,mistral-small-2603,deepseek-v4-flash-0731,gemma-4-31b-it,qwen3-8-27b,claude-haiku-5-5")
        return `models wrong: ${p.models}`;
      if (!p.by_model?.["mistral-small-2603"]?.polarity_distribution) return "per-model distributions missing";
      if (!p.by_model?.["gemma-4-31b-it"]?.polarity_distribution) return "the fourth model's distribution is missing";
      if (!p.by_model?.["qwen3-8-27b"]?.polarity_distribution) return "the fifth model's distribution is missing";
      if (!p.by_model?.["claude-haiku-5-5"]?.polarity_distribution) return "the sixth model's distribution is missing";
      // 5, not 6: qwen annotated nothing on row 104, so the common base is
      // SMALLER than the matched set. This is the assertion that fails if the
      // agreement base is ever silently widened back to every matched article.
      if (p.agreement?.scored_by_all !== 5)
        return `only 5 fixture articles carry all six judgements, got ${p.agreement?.scored_by_all}`;
      // Only 105 (Neutre) survives all six. 102 was unanimous among the first
      // three and gemma reads it Neutre — the row that proves a new member
      // actually moves the agreement number rather than riding along with it.
      if (p.agreement.unanimous !== 1) return `expected 1 unanimous article, got ${p.agreement.unanimous}`;
      // 1 of 5, not 1 of 6: the shrunken base moves the percentage too.
      if (p.agreement.unanimous_percent !== 20) return `expected 20%, got ${p.agreement.unanimous_percent}`;
      // 6 models → 15 unordered pairs, not 10.
      if (Object.keys(p.agreement.pairwise ?? {}).length !== 15)
        return `expected 15 pairwise counts, got ${JSON.stringify(p.agreement.pairwise)}`;
      if (p.agreement.pairwise?.["gpt-5-6-luna~gemma-4-31b-it"] === undefined) return "pairwise agreement missing a pair";
      if (p.agreement.pairwise?.["gemma-4-31b-it~qwen3-8-27b"] === undefined) return "pairwise agreement missing qwen";
      // Haiku mirrors luna, so it parts from Qwen only on row 103 (Très
      // positif against Positif): 4 of the 5 shared rows. A pair keyed but
      // never counted would show 0 here.
      if (p.agreement.pairwise?.["qwen3-8-27b~claude-haiku-5-5"] !== 4)
        return `qwen~haiku should agree on 4 of 5 shared rows, got ${p.agreement.pairwise?.["qwen3-8-27b~claude-haiku-5-5"]}`;
      // The uneven coverage must be stated, not left to be inferred from a
      // distribution that drops its unscored key.
      if (p.by_model["qwen3-8-27b"].coverage?.polarity !== 5)
        return `qwen coverage should be 5, got ${JSON.stringify(p.by_model["qwen3-8-27b"].coverage)}`;
      if (p.by_model["gpt-5-6-luna"].coverage?.polarity !== 6)
        return `luna coverage should be 6, got ${JSON.stringify(p.by_model["gpt-5-6-luna"].coverage)}`;
      if (!/12,098/.test(p.by_model["qwen3-8-27b"].model_caveat ?? ""))
        return "qwen's coverage caveat should travel with its numbers";
      if (p.by_model["gpt-5-6-luna"].model_caveat !== undefined)
        return "a complete model must not carry a coverage caveat";
      if (!p.agreement.base_caveats?.["qwen3-8-27b"]) return "the agreement base should name the short model";
      // The wide member is named too: its single-rater articles are outside the
      // base, which a reader cannot see from the base count alone.
      if (!/one vote/.test(p.agreement.base_caveats?.["claude-haiku-5-5"] ?? ""))
        return "the agreement base should name the wide model and why its extra rows are excluded";
      // The default pair is the first two in panel order, not the default model.
      if (p.agreement_matrix?.rows !== "gpt-5-6-luna") return "confusion matrix rows should be the first panel model";
      return null;
    },
  });
  // The newest panel member, asked for by id and by vendor shorthand. `google`
  // resolving here is the deliberate counterpart to `gemini` still being refused
  // below: one is a vendor, the other a model line that never ran generation 2.
  await call("get_sentiment_distribution", { model: "gemma-4-31b-it" }, {
    structured: true,
    check: (p) => {
      if (p.model !== "gemma-4-31b-it") return `model not echoed, got ${p.model}`;
      if (p.polarity_distribution?.Neutre !== 4)
        return `gemma reads 4 of 6 fixture rows Neutre, got ${JSON.stringify(p.polarity_distribution)}`;
      if (p.subjectivity?.scored !== 6) return `gemma scores every fixture row, got ${JSON.stringify(p.subjectivity)}`;
      return null;
    },
  });
  await call("get_sentiment_distribution", { model: "google" }, {
    structured: true,
    check: (p) => (p.model === "gemma-4-31b-it" ? null : `the google shorthand should resolve to Gemma, got ${p.model}`),
  });
  // The fifth member, and the only one whose single-model answer has to disclose
  // its own shortfall: 5 of the 6 matched rows, not 6.
  await call("get_sentiment_distribution", { model: "qwen" }, {
    structured: true,
    check: (p) => {
      if (p.model !== "qwen3-8-27b") return `the qwen shorthand should resolve to the model id, got ${p.model}`;
      if (p.total_articles !== 6) return `6 fixture articles match, got ${p.total_articles}`;
      if (p.coverage?.polarity !== 5 || p.coverage?.matched_articles !== 6)
        return `qwen should report 5 of 6 scored, got ${JSON.stringify(p.coverage)}`;
      if (p.subjectivity?.scored !== 5) return `qwen scores 5 fixture rows, got ${JSON.stringify(p.subjectivity)}`;
      if (!/12,098/.test(p.model_caveat ?? "")) return "the single-model answer should carry qwen's caveat";
      return null;
    },
  });
  await call("get_sentiment_distribution", { model: "mistral-small-2603" }, {
    structured: true,
    check: (p) => {
      if (p.model !== "mistral-small-2603") return "model not echoed";
      if (p.by_model) return "a single-model call should not return by_model";
      if (p.polarity_distribution?.Neutre !== 3) return `Neutre should be 3, got ${JSON.stringify(p.polarity_distribution)}`;
      // Subjectivity is an ordinal LABEL in generation 2, so the distribution is
      // keyed by label and any scalar must be flagged as a derived rank.
      const subj = p.subjectivity ?? {};
      if (subj.distribution?.["Plutôt objectif"] !== 3) return `label buckets wrong: ${JSON.stringify(subj.distribution)}`;
      if (!String(subj.scale ?? "").includes("Très subjectif")) return "subjectivity must declare its label scale";
      if (subj.mean_rank > 5 || subj.mean_rank < 1) return `mean_rank ${subj.mean_rank} outside the scale`;
      if (subj.mean !== undefined) return "the generation-1 numeric `mean` key must be gone";
      if (!subj.caveat) return "subjectivity must ship its reliability caveat";
      return null;
    },
  });
  // A model that declines to score some articles it did place on the other scales
  // must reconcile, not silently shrink the denominator.
  await call("get_sentiment_distribution", { model: "deepseek" }, {
    structured: true,
    check: (p) =>
      p.subjectivity?.scored === 5 && p.subjectivity?.unscored === 1
        ? null
        : `unscored subjectivity not reconciled: ${JSON.stringify(p.subjectivity)}`,
  });
  // The panel's own conclusion. The three fields deliberately do NOT behave alike,
  // and every assertion here is about a way they differ.
  await call("get_sentiment_distribution", { model: "consensus" }, {
    structured: true,
    check: (p) => {
      if (p.model !== "consensus") return `model not echoed, got ${p.model}`;
      if (p.by_model) return "consensus is not a per-model breakdown";
      // Row 103 has no polarity majority and row 104 no centrality majority, so
      // both label fields resolve on 5 of the 6 matched articles. The empty value
      // must not appear as a bucket.
      if (p.polarity_distribution?.[""] !== undefined) return "the no-majority rows must not be a bucket";
      if (p.coverage?.polarity !== 5) return `polarity consensus should cover 5, got ${JSON.stringify(p.coverage)}`;
      if (p.coverage?.centrality !== 5) return `centrality consensus should cover 5, got ${JSON.stringify(p.coverage)}`;
      // The asymmetry that makes consensus more than a fourth model: subjectivity
      // is a MEDIAN, so it resolves where a majority cannot form. If this ever
      // equals the label fields, the median has been reduced to a vote.
      if (p.coverage?.subjectivity !== 6)
        return `subjectivity median should resolve on all 6, got ${JSON.stringify(p.coverage)}`;
      const subj = p.subjectivity_median_rank ?? {};
      if (subj.distribution?.["2"] !== 3) return `median ranks wrong: ${JSON.stringify(subj.distribution)}`;
      if (p.subjectivity !== undefined) return "the label-shaped subjectivity block must not be used for a median";
      if (!/[Mm]edian of the votes cast/.test(subj.note ?? "")) return "the median must say it is not a majority";
      // Dispute counts: polarity split on 103, centrality on 104, subjectivity on
      // every row but 105.
      if (p.disputed?.polarite !== 1 || p.disputed?.centralite !== 1)
        return `label disputes wrong: ${JSON.stringify(p.disputed)}`;
      if (p.disputed?.subjectivite !== 5 || p.disputed?.any !== 5)
        return `subjectivity disputes wrong: ${JSON.stringify(p.disputed)}`;
      if (!/NO MAJORITY/.test(p.note ?? "")) return "an empty consensus value must be explained, not left ambiguous";
      // Which panel produced these rows: a five-voter and a six-voter majority
      // are different instruments, and only the fingerprint tells them apart.
      if (JSON.stringify(p.instrument_ids) !== JSON.stringify({ "sentiment-sha256:fixture": 6 }))
        return `instrument fingerprint missing or miscounted: ${JSON.stringify(p.instrument_ids)}`;
      return null;
    },
  });
  // consensus is NOT a model, so it must never be reachable through the model
  // registry: that is the line keeping a derived aggregate out of a field that
  // otherwise always names the exact model that judged.
  await call("get_sentiment_distribution", { model: "consensus-polarite" }, {
    expectError: true,
    checkBody: (b) => (b.includes("Invalid model") ? null : `expected an invalid-model error, got: ${b.slice(0, 200)}`),
  });
  // model:"all" answers "how far do they agree"; the consensus rides along so the
  // caller also gets "and what did they conclude" without a second call. Row 104
  // is the proof they are not the same set: qwen skipped it, so it is absent from
  // scored_by_all yet present in the consensus.
  await call("get_sentiment_distribution", { model: "all" }, {
    structured: true,
    check: (p) => {
      if (!p.consensus) return "model:all should carry the panel's conclusion";
      if (p.consensus.coverage?.polarity !== 5) return `consensus coverage wrong: ${JSON.stringify(p.consensus.coverage)}`;
      if (p.agreement?.scored_by_all !== 5) return "agreement base changed unexpectedly";
      if (p.consensus.polarity_distribution?.Neutre !== 3)
        return `row 104 should be decided by its 5 remaining voters: ${JSON.stringify(p.consensus.polarity_distribution)}`;
      return null;
    },
  });
  // Reading the contested articles, not just counting them.
  await call("search_by_sentiment", { disputed: "polarite" }, {
    check: (p) => (p.total_matches === 1 ? null : `only article 103 splits on polarity, got ${p.total_matches}`),
  });
  await call("search_by_sentiment", { disputed: "subjectivite" }, {
    check: (p) => (p.total_matches === 5 ? null : `5 fixture rows split on subjectivity, got ${p.total_matches}`),
  });
  // English field names are NOT the stored vocabulary, so they must fail loudly
  // with the real values rather than silently matching nothing.
  await call("search_by_sentiment", { disputed: "polarity" }, {
    expectError: true,
    checkBody: (b) =>
      b.includes("polarite") ? null : `the error should list the stored field names, got: ${b.slice(0, 200)}`,
  });
  // Vendor shorthand resolves to the model that ran, and the payload echoes the id.
  await call("get_sentiment_distribution", { model: "chatgpt" }, {
    structured: true,
    check: (p) => (p.model === "gpt-5-6-luna" ? null : `vendor alias should resolve to the model id, got ${p.model}`),
  });
  // The raw dataset column prefix is accepted too (underscores ≡ hyphens).
  await call("get_sentiment_distribution", { model: "mistral_small_2603" }, {
    structured: true,
    check: (p) => (p.model === "mistral-small-2603" ? null : `column prefix should resolve, got ${p.model}`),
  });
  // A generation-1 id names a real annotator this server no longer serves. It
  // must say so rather than answer with the same vendor's generation-2 model,
  // which read the corpus differently.
  for (const retired of ["gpt-5-mini", "gemini-3-flash-preview", "ministral-14b-2512", "gemini"]) {
    await call("get_sentiment_distribution", { model: retired }, {
      expectError: true,
      checkBody: (b) =>
        b.includes("generation-2") && b.includes("gpt-5-6-luna")
          ? null
          : `retired model ${retired} should be refused by name, got: ${b.slice(0, 200)}`,
    });
  }
  await call("get_sentiment_distribution", { model: "llama" }, {
    expectError: true,
    checkBody: (b) =>
      b.includes("valid_values") && b.includes("deepseek-v4-flash-0731")
        ? null
        : "an unknown model should list the valid ones by model id",
  });
}
