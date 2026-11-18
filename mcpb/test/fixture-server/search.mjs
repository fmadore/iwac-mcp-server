// Fixture-server checks for finding and reading items: unified search and
// fetch, the articles tools, references (the pipe country trap), the index and
// the authority lists. Called in order by test/fixture-server.test.mjs.

/** Runs on the shared legacy-era client, in file order. */
export async function searchChecks({ call }) {
  // --- unified search / fetch (ChatGPT contract: both blocks) -------------------
  const hits = await call("search", { query: "pèlerinage" }, {
    structured: true,
    check: (p) => {
      if (!p.results?.length) return "no results for pèlerinage";
      if (!p.results.every((r) => r.id && r.url && r.category)) return "result missing id/url/category";
      const cats = new Set(p.results.map((r) => r.category));
      if (cats.size < 2) return `expected matches across categories, got ${[...cats].join(", ")}`;
      return null;
    },
  });
  await call("search", { query: "pèlerinage Mecque" }, {
    structured: true,
    check: (p) => (p.results?.length ? null : "multi-word tokenized query matched nothing"),
  });
  await call("search", { query: "PELERINAGE" }, {
    check: (p) => (p.results?.length ? null : "unaccented uppercase query matched nothing (fold regressed)"),
  });
  if (hits?.results?.length) {
    await call("fetch", { id: hits.results[0].id }, {
      structured: true,
      check: (p) => {
        if (!p.text) return "fetch missing text";
        if (!p.url) return "fetch missing url";
        if (typeof p.metadata !== "object") return "fetch missing metadata object";
        return null;
      },
    });
  }
  // Long-OCR article: fetch must cap and point at get_article.
  await call("fetch", { id: "articles:105" }, {
    structured: true,
    check: (p) => {
      if (p.text_truncated !== true) return "30k-char OCR should set text_truncated";
      if (p.recommended_tool !== "get_article") return `expected recommended_tool get_article, got ${p.recommended_tool}`;
      if (p.text.length > 26_000) return `capped text still too large: ${p.text.length}`;
      if (!String(p.metadata.truncation_message).includes("Call get_article with offset 25000"))
        return `truncation_message should say how to read the rest: ${p.metadata.truncation_message}`;
      return null;
    },
  });
  await call("fetch", { id: "garbage" }, {
    expectError: true,
    checkBody: (b) => (b.includes("valid_categories") ? null : "malformed id should list valid_categories"),
  });

  // A query whose every token is under the 2-char floor is never RUN. Returning
  // count:0 for it would be indistinguishable from a real absence, so it must be
  // a self-correctable error instead.
  await call("search", { query: "a" }, {
    expectError: true,
    checkBody: (b) => (b.includes("no usable search term") ? null : "sub-2-char query should be refused, not silently empty"),
  });
  // …whereas a real term with no matches IS a successful, empty search.
  await call("search", { query: "zzzznotaterm" }, {
    structured: true,
    check: (p) => (p.count === 0 && !p.error ? null : "an unattested term should be an empty success, not an error"),
  });
  // Two-phase search: a term that lives only in an OCR blob still has to surface,
  // which means the deep pass ran and said so.
  await call("search", { query: "pédagogique" }, {
    structured: true,
    check: (p) => {
      if (!p.results?.length) return "OCR/abstract-only term found nothing (deep pass regressed)";
      if (p.deep_scan !== true) return "deep_scan should be true when the fast pass under-fills";
      return null;
    },
  });
  // Photographs are searchable through the unified entry point too.
  await call("search", { query: "mosquée" }, {
    structured: true,
    check: (p) => (p.results?.some((r) => r.category === "images") ? null : "images subset missing from unified search"),
  });
  // Audiovisual items have no descriptionAI at all (0/1,771 in the real subset);
  // the transcription is their only text, so fetch must return it as `text`.
  await call("fetch", { id: "audiovisual:601" }, {
    structured: true,
    check: (p) => {
      if (!p.text?.includes("Tafsirin")) return `audiovisual fetch should return the transcription, got: ${String(p.text).slice(0, 60)}`;
      if (!p.url) return "audiovisual fetch missing url";
      return null;
    },
  });

  // --- articles ------------------------------------------------------------------
  await call("search_articles", { country: "Bénin" }, {
    check: (p) => (p.total_matches === 2 ? null : `accented Bénin should match 2 fixture articles, got ${p.total_matches}`),
  });
  await call("search_articles", { keyword: "pelerinage" }, {
    check: (p) => (p.total_matches >= 2 ? null : `unaccented keyword should reach accented OCR, got ${p.total_matches}`),
  });
  // The English half of the bilingual AI summary must be searchable. "pilgrimage"
  // appears ONLY in `descriptionAI_en` — nowhere in a title, a French summary or
  // the OCR — so a hit here can only have come through the English column. If the
  // dataset splits `descriptionAI` by language and the server forgets to mark the
  // English side searchable, English queries silently stop matching summaries,
  // which is worse for anglophone discovery than the pipe-joined column was.
  await call("search_articles", { keyword: "pilgrimage" }, {
    check: (p) => (p.total_matches === 1 && String(p.results?.[0]?.id) === "101"
      ? null
      : `English-only summary term should find article 101, got ${p.total_matches}`),
  });
  // …and through the unified `search`, whose cheap first pass is FAST_TEXT_COLS.
  await call("search", { query: "pilgrimage" }, {
    structured: true,
    check: (p) => (p.results?.some((r) => String(r.id).endsWith("101"))
      ? null
      : "unified search should reach the English summary on the fast pass"),
  });
  await call("search_articles", { country: "Atlantis" }, {
    expectError: true,
    checkBody: (b) => (b.includes("valid_values") ? null : "invalid country should error with valid_values"),
  });
  await call("search_articles", { country: "Nigeria" }, {
    check: (p) => (p.total_matches === 0 ? null : "fixture Nigeria articles should be empty (real absence)"),
  });
  await call("search_articles", { subject: "Mosquée", date_from: "2001", date_to: "2003" }, {
    check: (p) => (p.total_matches === 2 ? null : `pipe subject + date range expected 2, got ${p.total_matches}`),
  });
  await call("get_article", { article_id: 105, keyword: "pelerinage" }, {
    check: (p) => {
      if (!(p.match_count >= 100)) return `expected many matches in repeated OCR, got ${p.match_count}`;
      if (!(p.excerpts_returned <= 10)) return `excerpt cap regressed: ${p.excerpts_returned}`;
      return null;
    },
  });
  await call("get_article", { article_id: 99999 }, { expectError: true });
  // The rest of a long OCR is readable by following next_offset, not just
  // reachable through keyword excerpts.
  let firstPart = "";
  await call("get_article", { article_id: 105 }, {
    check: (p) => {
      if (p.truncated !== true || p.next_offset !== 25_000) return `first part should stop at 25000, got ${p.next_offset}`;
      if (!(p.char_count > 25_000)) return "char_count should report the whole OCR";
      if (!String(p.truncation_message).includes("offset 25000")) return "truncation_message should say how to read on";
      firstPart = p.ocr_text;
      return null;
    },
  });
  await call("get_article", { article_id: 105, offset: 25_000 }, {
    check: (p) => {
      if (p.offset !== 25_000 || p.next_offset !== undefined || p.truncated) return "second part should be the last";
      if (firstPart.length + p.ocr_text.length !== p.char_count) return "the two parts should add up to the whole OCR";
      if (!p.url) return "the rest of the record should still come back";
      return null;
    },
  });
  await call("get_article", { article_id: 105, offset: 99_999 }, {
    check: (p) => (p.ocr_text === undefined && /past the end/.test(p.note) ? null : "offset past the end should say so"),
  });
  // A limit under the floor is clamped to 1 — say so, exactly as an over-large
  // one is. Silently returning a single row reads as "that is all there is".
  await call("search_articles", { limit: 0 }, {
    check: (p) => {
      if (p.limit !== 1) return `limit 0 should clamp to 1, got ${p.limit}`;
      if (p.requested_limit !== 0 || !String(p.limit_warning ?? "").includes("below the minimum"))
        return "low-end clamp must surface requested_limit + limit_warning";
      return null;
    },
  });
  // Same rule for the excerpt caps.
  await call("get_article", { article_id: 105, keyword: "pelerinage", max_excerpts: -3 }, {
    check: (p) =>
      p.excerpts_returned === 1 && String(p.parameter_note ?? "").includes("max_excerpts")
        ? null
        : "clamped max_excerpts should be reported in parameter_note",
  });

  // --- references (pipe country trap) --------------------------------------------
  await call("search_references", { country: "Niger" }, {
    check: (p) => (p.total_matches === 1 ? null : `Niger must match only the Niger|Nigeria row, got ${p.total_matches}`),
  });
  await call("search_references", { country: "Nigeria" }, {
    check: (p) => (p.total_matches === 2 ? null : `Nigeria should match pipe row + Nigeria-only row, got ${p.total_matches}`),
  });
  await call("search_references", { reference_type: "Livre" }, {
    check: (p) => (p.total_matches === 2 ? null : `'Livre' substring should match Livre + Chapitre de livre, got ${p.total_matches}`),
  });
  await call("search_references", { keyword: "sharia" }, {
    check: (p) => {
      if (p.total_matches < 1) return "English abstract keyword matched nothing";
      const long = p.results.find((r) => r.abstract_snippet?.endsWith("…"));
      return long || p.results.some((r) => r.abstract_snippet) ? null : "no abstract_snippet in results";
    },
  });
  await call("get_reference", { reference_id: 301 }, {
    check: (p) => (typeof p.abstract === "string" && p.abstract.length > 320 ? null : "full abstract missing on get_reference"),
  });

  // --- index / lists ---------------------------------------------------------------
  await call("search_index", { keyword: "Dahomey" }, {
    check: (p) => (p.results?.some((r) => r.title === "Bénin") ? null : "alias Dahomey did not resolve to Bénin"),
  });
  await call("search_index", { keyword: "conférence", index_type: "evenements" }, {
    check: (p) => (p.total_matches === 1 ? null : `unaccented index_type should match Événements, got ${p.total_matches}`),
  });
  await call("search_index", { keyword: "x", index_type: "people" }, {
    expectError: true,
    checkBody: (b) => (b.includes("valid_values") ? null : "invalid index_type should list valid_values"),
  });
  await call("list_subjects", { limit: 500 }, {
    check: (p) => {
      if (p.limit !== 200) return `applied limit should be 200, got ${p.limit}`;
      if (p.requested_limit !== 500 || !p.limit_warning) return "visible-cap fields missing";
      return null;
    },
  });
  // `with_description` lowers this tool's own maximum, because 100 rows carrying a
  // ~500-char abstract each is ~27k tokens — past the ceiling Claude Code applies
  // to a tool result, so the caller receives nothing at all. The clamp has to be
  // visible for the same reason every other clamp here is.
  await call("search_articles", { limit: 100, with_description: true }, {
    check: (p) => {
      if (p.limit !== 25) return `with_description should cap the limit at 25, got ${p.limit}`;
      if (p.requested_limit !== 100) return "visible-cap fields missing on the with_description cap";
      if (!String(p.limit_warning ?? "").includes("with_description"))
        return "limit_warning should name with_description as the reason";
      return null;
    },
  });
  await call("search_articles", { limit: 100 }, {
    check: (p) => (p.limit === 100 ? null : `without with_description the limit should stay 100, got ${p.limit}`),
  });
  await call("list_locations", { country: "Togo" }, {
    check: (p) => {
      if (!p.results?.some((r) => r.title === "Bénin")) return "Bénin (countries Benin|Togo) should appear under Togo";
      if (!String(p.note ?? "").includes("mentioned-in")) return "mentioned-in note missing";
      return null;
    },
  });
  await call("list_persons", {}, {
    check: (p) => (p.results?.some((r) => r.title === "El Hadj Omar Tall") ? null : "persons list missing fixture person"),
  });
  await call("get_index_entry", { entry_id: 403 }, {
    check: (p) => (p.Titre === "El Hadj Omar Tall" ? null : `get_index_entry returned wrong entry: ${JSON.stringify(p).slice(0, 120)}`),
  });
  await call("get_index_entry", { entry_id: 99999 }, { expectError: true });
}
