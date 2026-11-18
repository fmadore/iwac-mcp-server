// Fixture-server checks for the other collections: publications, documents,
// audiovisual records and images, plus literal LIKE metacharacters. Called in
// order by test/fixture-server.test.mjs.

/** Runs on the shared legacy-era client, in file order. */
export async function collectionChecks({ call }) {
  // --- publications / documents / audiovisual --------------------------------------
  await call("search_publications", { keyword: "pèlerinage" }, {
    check: (p) => {
      if (p.total_matches !== 1) return `expected 1 publication, got ${p.total_matches}`;
      if (!p.results?.[0]?.matching_toc_entries?.includes("pèlerinage")) return "matching_toc_entries missing";
      return null;
    },
  });
  await call("get_publication_fulltext", { publication_id: 203, keyword: "pelerinage" }, {
    check: (p) => (p.match_count >= 1 ? null : "unaccented keyword found nothing in publication OCR"),
  });
  // The contents come with the first part only, not again with each of an
  // issue's (up to 45) later parts.
  await call("get_publication_fulltext", { publication_id: 203 }, {
    check: (p) => (p.tableOfContents && p.char_count === p.fulltext.length ? null : "first part should carry the TOC and the whole short OCR"),
  });
  await call("get_publication_fulltext", { publication_id: 203, offset: 10 }, {
    check: (p) => {
      if (p.tableOfContents) return "a later part should not repeat the table of contents";
      if (p.offset !== 10 || p.fulltext.length !== p.char_count - 10) return `expected the OCR from character 10, got offset ${p.offset}`;
      return null;
    },
  });
  await call("search_documents", {}, {
    check: (p) => (p.total_matches === 2 ? null : `expected 2 documents, got ${p.total_matches}`),
  });
  await call("get_document", { document_id: 501 }, {
    check: (p) => (p.ocr_text ? null : "get_document returned no OCR"),
  });
  await call("search_audiovisual", { language: "Haoussa" }, {
    check: (p) => (p.total_matches === 1 ? null : `Haoussa should match 1, got ${p.total_matches}`),
  });
  await call("search_audiovisual", { language: "Anglais" }, {
    check: (p) => (p.total_matches === 1 ? null : "pipe language Arabe|Anglais should match Anglais"),
  });
  // Unaccented and lower-cased: the real vocabulary is accented French
  // ("Vidéo sur le web"), so a caller typing it plainly must still match.
  await call("search_audiovisual", { medium: "video sur le web" }, {
    check: (p) => (p.total_matches === 1 ? null : `case/accent-folded medium should match 1 video, got ${p.total_matches}`),
  });
  await call("search_audiovisual", { medium: "vinyl" }, {
    expectError: true,
    checkBody: (b) => (b.includes("valid_values") ? null : "invalid medium should error with valid_values"),
  });
  await call("list_audiovisual", {}, {
    check: (p) => {
      if (p.total_matches !== 3) return `expected 3 audiovisual items, got ${p.total_matches}`;
      // Newest first, so the harvested video leads: it has a watch URL and NO
      // file, and a row must show which of the two it is without a second call.
      const first = p.results?.[0];
      if (first?.id !== "603") return `expected the newest row first, got ${first?.id}`;
      if (first?.source_type !== "youtube") return "list rows should carry source_type";
      if (!first?.external_url?.includes("youtube.com")) return "a harvested row must expose its watch URL";
      if (first?.media_url) return "a harvested row has no file, so it must not advertise a media_url";
      if (first?.duration_seconds !== 411) return `expected the duration in seconds, got ${first?.duration_seconds}`;
      if (!p.results?.some((r) => r.media_url)) return "the deposited rows should still expose media_url";
      return null;
    },
  });
  // The two cohorts are separable, and each filter finds the right one. Until the
  // fixture held a harvested row, both of these passed by matching nothing.
  await call("list_audiovisual", { source_type: "youtube" }, {
    check: (p) => (p.total_matches === 1 ? null : `source_type=youtube should match 1, got ${p.total_matches}`),
  });
  await call("list_audiovisual", { source_type: "deposited" }, {
    check: (p) => (p.total_matches === 2 ? null : `source_type=deposited should match 2, got ${p.total_matches}`),
  });
  await call("list_audiovisual", { source_type: "vhs" }, {
    expectError: true,
    checkBody: (b) => (b.includes("valid_values") ? null : "an invalid source_type should error with valid_values"),
  });
  // The subset is no longer Nigeria-only: country must select either cohort.
  await call("list_audiovisual", { country: "Burkina Faso" }, {
    check: (p) => {
      if (p.total_matches !== 1) return `Burkina Faso should match the harvested video, got ${p.total_matches}`;
      return p.results?.[0]?.id === "603" ? null : `wrong row for Burkina Faso: ${p.results?.[0]?.id}`;
    },
  });
  await call("list_audiovisual", { country: "Nigeria" }, {
    check: (p) => (p.total_matches === 2 ? null : `Nigeria should still match the deposited pair, got ${p.total_matches}`),
  });
  // The channel facet: 27 of 1,771 real rows carry a subject, 1,769 carry a
  // publisher, so this is the one that has to work. Substring, because nobody
  // types "RTB - Radiodiffusion Télévision du Burkina".
  await call("search_audiovisual", { publisher: "RTB" }, {
    check: (p) => (p.total_matches === 1 ? null : `publisher substring should match the channel, got ${p.total_matches}`),
  });
  await call("search_audiovisual", { publisher: "radiodiffusion television" }, {
    check: (p) => (p.total_matches === 1 ? null : "publisher matching must be accent- and case-insensitive"),
  });
  await call("get_audiovisual", { audiovisual_id: 601 }, {
    check: (p) => {
      if (!p.media_url || p.medium !== "CD") return "get_audiovisual missing media_url/medium";
      if (p.source_type !== "deposited") return "get_audiovisual should say which cohort the row is from";
      if (!p.transcription) return "get_audiovisual should expose the OCR transcription";
      if (!p.description?.includes("matafiyi")) return "get_audiovisual should expose the full description";
      if (p.duration_seconds !== 3480 || p.extent !== "PT58M") return "get_audiovisual should expose both duration forms";
      if (!p.rights) return "get_audiovisual should expose rights";
      return null;
    },
  });
  // The record #20 was opened for: three links with three meanings. The IWAC page
  // is the citable one, the watch URL is where the video plays, and media_url —
  // absent here — is a file. Inferring "every PDF is a file" was the old contract.
  // A transcription can run to ~470k characters, so it takes the same
  // keyword-excerpt path as an article's OCR instead of shipping whole.
  await call("get_audiovisual", { audiovisual_id: 601, keyword: "ramadan" }, {
    check: (p) => {
      if (p.transcription) return "with a keyword, the transcription should be replaced by excerpts";
      if (!(p.match_count >= 1) || !p.excerpts?.[0]?.includes("Ramadan")) return "expected an excerpt around 'Ramadan'";
      if (!p.description) return "the rest of the record should still come back";
      return null;
    },
  });
  await call("get_audiovisual", { audiovisual_id: 603 }, {
    check: (p) => {
      if (!p.url?.includes("/item/603")) return "get_audiovisual should return the IWAC catalogue page";
      if (p.external_url !== "https://www.youtube.com/watch?v=xcGWG5msEEs") return `wrong watch URL: ${p.external_url}`;
      if (p.media_url) return "a harvested row must not report a media file it does not have";
      if (p.iiif_manifest) return "a harvested row has a 0-canvas manifest, so it must not advertise one";
      if (p.publisher !== "RTB - Radiodiffusion Télévision du Burkina") return "the channel should be the publisher";
      if (p.creator) return "harvested rows carry no creator";
      if (!p.description?.includes("Ouagadougou")) return "the blurb is the only text this row has";
      if (p.transcription) return "this row has no transcription";
      return null;
    },
  });
  await call("search_audiovisual", { keyword: "Tafsirin" }, {
    check: (p) => (p.total_matches === 1 ? null : `transcription text should be searchable, got ${p.total_matches}`),
  });
  // `description` is the only text 1,465 of the 1,771 real rows have, so it must be
  // in the search surface — and in the FAST half of it, since the unified `search`
  // only falls through to the heavy transcription scan when a page under-fills.
  await call("search_audiovisual", { keyword: "concorde" }, {
    check: (p) => (p.total_matches === 1 ? null : `description text should be searchable, got ${p.total_matches}`),
  });
  await call("search", { query: "concorde" }, {
    structured: true,
    check: (p) =>
      p.results?.some((r) => r.id === "audiovisual:602")
        ? null
        : "an audiovisual item should be findable through unified search by its description alone",
  });
  // Search rows carry a capped snippet, not the whole blurb; the full text is one
  // get_audiovisual away. Mirrors references' abstract_snippet.
  await call("search_audiovisual", { keyword: "Retransmission" }, {
    check: (p) => {
      const row = p.results?.[0];
      if (!row) return "no row to inspect for the description snippet";
      if (!row.description_snippet?.includes("Retransmission")) return "search rows should carry description_snippet";
      if (row.description) return "search rows should carry the snippet, not the full description";
      return null;
    },
  });
  // 602 has a description and no transcription: `fetch` must answer with the
  // description rather than "(no full text available)", and say which it gave.
  await call("fetch", { id: "audiovisual:602" }, {
    structured: true,
    check: (p) => {
      if (!p.text?.includes("Retransmission")) return `fetch should fall back to the description, got: ${String(p.text).slice(0, 60)}`;
      if (p.text_source !== "description") return "fetch should disclose that `text` is the description, not a transcription";
      if (p.metadata?.description) return "the description should not be repeated in metadata once it IS the text";
      return null;
    },
  });
  // 601 has both: the transcription is the body, and the description stays beside it.
  await call("fetch", { id: "audiovisual:601" }, {
    structured: true,
    check: (p) => {
      if (!p.text?.includes("Tafsirin")) return "fetch should prefer the transcription over the description";
      if (p.text_source) return "text_source should be absent when the body column supplied the text";
      if (!p.metadata?.description) return "the description should ride in metadata when the transcription is the text";
      return null;
    },
  });

  // --- images (photographs) ------------------------------------------------------
  await call("search_images", {}, {
    check: (p) => {
      if (p.total_matches !== 3) return `expected 3 photographs, got ${p.total_matches}`;
      const first = p.results?.[0];
      if (!first?.image_url) return "image results must carry image_url";
      if (!first?.coordinates) return "image results must carry coordinates";
      return null;
    },
  });
  await call("search_images", { country: "Togo" }, {
    check: (p) => (p.total_matches === 1 ? null : `Togo should match 1 photograph, got ${p.total_matches}`),
  });
  await call("search_images", { spatial: "Ouagadougou" }, {
    check: (p) => (p.total_matches === 1 ? null : `place filter should match 1, got ${p.total_matches}`),
  });
  await call("search_images", { keyword: "ecole" }, {
    check: (p) => (p.total_matches === 1 ? null : `unaccented keyword should reach 'École', got ${p.total_matches}`),
  });
  await call("search_images", { country: "Atlantis" }, {
    expectError: true,
    checkBody: (b) => (b.includes("valid_values") ? null : "invalid country should error with valid_values"),
  });
  await call("get_image", { image_id: 702 }, {
    check: (p) => (p.image_url && p.description ? null : "get_image missing image_url/description"),
  });
  await call("get_image", { image_id: 99999 }, { expectError: true });

  // LIKE metacharacters in a keyword must match literally, not as wildcards: an
  // unescaped '_' is a single-char wildcard and would match EVERY article.
  await call("search_articles", { keyword: "_" }, {
    check: (p) => (p.total_matches === 0 ? null : `literal '_' should match nothing, got ${p.total_matches} (LIKE escaping regressed)`),
  });
}
