// Generate SYNTHETIC parquet fixtures for the offline server test.
//
// The rows are invented but mirror the real dataset's shape and conventions:
// exact column names (incl. French/quoted ones), empty strings instead of
// NULLs, pipe-joined multi-values, accented text, bare-year vs full ISO dates,
// one >25k-char OCR blob (truncation path), a 'Niger|Nigeria' reference (pipe
// country trap), and no Nigerian press articles. Nothing from the licensed
// dataset is copied, so the fixtures are safe to regenerate anywhere — they are
// gitignored and rebuilt by `npm run test:fixture`.
//
// Output: test/fixtures/<subset>/train-00000-of-00001.parquet
import { DuckDBInstance } from "@duckdb/node-api";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = path.join(root, "test", "fixtures");

const IWAC = "https://islam.zmo.de/s/afrique_ouest/item/";

/** Subsets that carry an `OCR` column, and therefore the per-row public flag. */
const OCR_SUBSETS = ["articles", "publications", "documents", "audiovisual"];

/**
 * Subsets carrying the AI summary. Since the summariser went bilingual the
 * dataset stores the two `@language` literals as `descriptionAI` (fr) and
 * `descriptionAI_en` rather than pipe-joining them, so the fixture must hold
 * both — an English-only term has to be findable, which is the whole point of
 * tagging the English column `searchable`.
 */
const DESC_AI_SUBSETS = ["articles", "documents", "audiovisual"];

/**
 * English summaries, keyed by `o:id`. Deliberately NOT translations of the
 * French: each uses vocabulary ("pilgrimage", "fasting") that appears nowhere
 * in the French text or the OCR, so a test matching one proves the English
 * column is really in the search surface rather than riding on a shared token.
 * Audiovisual is absent on purpose — 0/1,771 filled in the real subset.
 */
const DESC_AI_EN = {
  101: "Report on the pilgrimage of Beninese faithful to Mecca.",
  102: "The fasting month as lived in the capital's mosques.",
  103: "Celebrations marking the end of the fasting month in Abidjan.",
  501: "Annual report of a Burkinabè Muslim students' association.",
};

/**
 * Subsets the pipeline writes Hijri date columns to
 * (post-processing/calculate_hijri_dates.py). `references` is deliberately
 * absent there — an academic imprint date has no meaningful lunar reading — and
 * so is absent here, which is what lets the tests assert that asking for a
 * lunar bucket on `references` is a clean error rather than a silent empty.
 */
const HIJRI_SUBSETS = ["articles", "publications", "documents", "audiovisual", "images"];

/**
 * Gregorian → Umm al-Qura for every date the fixtures use, computed with
 * `hijridate` (the pipeline's converter of record) rather than with Node's
 * `Intl`. Hard-coded on purpose: baking a second converter into this repo is
 * exactly the drift the precomputed columns exist to prevent, and the two
 * disagree on most pre-2000 dates — several of which are in this table.
 *
 * All 6 fixture articles carry a complete date, so their lunar months spread
 * over Rajab / Muharram / Jumada II / Dhu al-Qa'da ×2 / Ramadan — a
 * distribution with a real peak. The imprecise-date path is exercised by
 * `publications` (1912, 1998) and `documents` (1990), whose year-only dates
 * stay NULL here and must surface as `imprecise_date_count`.
 */
const HIJRI = {
  "1987-03-02": [1407, 7, 2],
  "1994-01-01": [1414, 7, 19],
  "1995-06-01": [1416, 1, 3],
  "1995-06-15": [1416, 1, 17],
  "2001-09-14": [1422, 6, 26],
  "2003-01-10": [1423, 11, 7],
  "2010-11-01": [1431, 11, 24],
  "2015-04-16": [1436, 6, 27],
  "2018-11-02": [1440, 2, 24],
  "2019-02-11": [1440, 6, 6],
  "2019-05-20": [1440, 9, 15],
  "2020-04-25": [1441, 9, 2],
  "2021-06-11": [1442, 11, 1],
  "2023-05-01": [1444, 10, 11],
  "2023-06-12": [1444, 11, 23],
  "2024-03-16": [1445, 9, 6],
  "2024-05-20": [1445, 11, 12],
};

/** One CREATE + INSERT block per subset (plain SQL keeps the data reviewable). */
const SUBSET_SQL = {
  articles: `
    CREATE TABLE articles (
      "o:id" VARCHAR, identifier VARCHAR, title VARCHAR, author VARCHAR,
      newspaper VARCHAR, country VARCHAR, pub_date VARCHAR, subject VARCHAR,
      spatial VARCHAR, language VARCHAR, "descriptionAI" VARCHAR, "OCR" VARCHAR,
      -- Sentiment columns are named for the MODEL that scored the corpus, not
      -- the vendor slot it ran in, and these are the GENERATION-2 models — a
      -- fixture on generation 1's names would let the server's schema.has()
      -- guards pass a build that reads nothing.
      gpt_5_6_luna_polarite VARCHAR,
      gpt_5_6_luna_centralite_islam_musulmans VARCHAR,
      -- VARCHAR, not DOUBLE. Generation 2 stores subjectivity as an ordinal
      -- French LABEL while keeping the "..._score" column name from generation
      -- 1, when it was a 1-5 float. The name is the trap; the fixture types it
      -- the way the parquet does so the aggregate path is tested on a string.
      gpt_5_6_luna_subjectivite_score VARCHAR, nb_mots BIGINT, nb_pages BIGINT,
      "Richesse_Lexicale_OCR" DOUBLE, "Lisibilite_OCR" DOUBLE, iwac_url VARCHAR,
      -- LDA topics and the three further sentiment models, so the aggregate
      -- tools have something to aggregate.
      lda_topic_id DOUBLE, lda_topic_prob DOUBLE, lda_topic_label VARCHAR,
      mistral_small_2603_polarite VARCHAR, mistral_small_2603_centralite_islam_musulmans VARCHAR,
      mistral_small_2603_subjectivite_score VARCHAR,
      deepseek_v4_flash_0731_polarite VARCHAR, deepseek_v4_flash_0731_centralite_islam_musulmans VARCHAR,
      deepseek_v4_flash_0731_subjectivite_score VARCHAR,
      -- The fourth panel member (2026-08-17). Its values deliberately break the
      -- unanimity the other three had on row 102, mirroring what adding it did
      -- to the real corpus (4-way agreement on polarity 36.5%, against 43.1%
      -- for the first three): a fixture where a new model never changes an
      -- aggregate cannot fail when that model is dropped from the panel.
      gemma_4_31b_it_polarite VARCHAR, gemma_4_31b_it_centralite_islam_musulmans VARCHAR,
      gemma_4_31b_it_subjectivite_score VARCHAR,
      -- The fifth member (2026-08-25). Unlike the other four it does NOT cover
      -- the whole corpus: 200 articles were attempted four times, never
      -- annotated, and then retired, and they concentrate on articles the panel
      -- reads as peripheral to Islam. Row 104 -- the one every model calls
      -- Marginal or Secondaire -- is left entirely empty here to mirror that,
      -- because an all-scored fixture would never exercise the case where the
      -- agreement base is SMALLER than the matched set.
      qwen3_8_27b_polarite VARCHAR, qwen3_8_27b_centralite_islam_musulmans VARCHAR,
      qwen3_8_27b_subjectivite_score VARCHAR,
      -- The panel's own conclusion, precomputed upstream (2026-08-25). Derived
      -- here from the five votes above so the fixture stays readable, but the
      -- server reads these columns and never recomputes them.
      --
      -- The majority threshold follows the votes ACTUALLY CAST (over half, min
      -- 2), which is why row 104 has a polarity consensus at all: qwen skipped
      -- it, so its four remaining voters decide it. That row is in the consensus
      -- and NOT in agreement.scored_by_all, while row 103 is the reverse, which
      -- is the whole reason both are worth serving.
      --
      -- Empty means NO MAJORITY (103 polarity splits 2/2/1, 104 centrality 2/2),
      -- never "not computed". Subjectivity is a float MEDIAN rank instead of a
      -- majority label, so it resolves on all 6 rows where the two label fields
      -- reach only 5: coverage.subjectivity > coverage.polarity is the shape to
      -- protect. Half-ranks (1.5, 2.5) need an even split and cannot occur on a
      -- 6-row fixture whose models vote 5-at-a-time without making the votes
      -- contradict each model's documented abstention policy; the live smoke
      -- test covers them against the 117 real rows that have one.
      consensus_polarite VARCHAR, consensus_centralite VARCHAR,
      consensus_subjectivite_score DOUBLE, sentiment_disagreement VARCHAR,
      -- Toy 4-d embeddings, not the real 768. The PCA projection does not care
      -- about dimensionality, and these are laid out as two separable clusters
      -- (the hadj/pilgrimage rows against the rest) so the projection has a
      -- real structure to find rather than noise.
      embedding_OCR DOUBLE[]
    );
    INSERT INTO articles VALUES
      ('101', 'iwac-101', 'Le pèlerinage à La Mecque vu de Cotonou', 'A. Dossou',
       'La Nation', 'Benin', '1995-06-15', 'Pèlerinage|Religion', 'Cotonou|La Mecque', 'Français',
       'Reportage sur le départ des pèlerins béninois pour La Mecque.',
       'Cette année encore, le pèlerinage à La Mecque mobilise des centaines de fidèles depuis Cotonou. Les autorités saluent l''organisation du hadj.',
       'Neutre', 'Central', 'Plutôt objectif', 120, 1, 0.62, 41.5, '${IWAC}101', 12, 0.47, 'pèlerin - hadj - organisation_hadj', 'Neutre', 'Central', 'Plutôt objectif', 'Positif', 'Central', 'Plutôt objectif', 'Neutre', 'Central', 'Très objectif', 'Neutre', 'Central', 'Plutôt objectif',
       -- Neutre 4/5; gemma alone reads subjectivity Très objectif, so only that
       -- field is flagged. A flagged label field would mean no majority; a
       -- flagged subjectivity just means the voters were spread.
       'Neutre', 'Central', 2.0, 'subjectivite', [0.90, 0.10, 0.05, 0.02]),
      ('102', 'iwac-102', 'Ramadan à Ouagadougou', 'B. Ouedraogo',
       'Sidwaya', 'Burkina Faso', '2003-01-10', 'Mosquée|Ramadan', 'Ouagadougou', 'Français',
       'Le mois de jeûne vécu dans les mosquées de la capitale burkinabè.',
       'Le ramadan à Ouagadougou rassemble les fidèles dans les mosquées chaque soir.',
       -- gemma reads this one Neutre where the other four say Positif: the row
       -- that stops the fixture's unanimity count from being a constant.
       'Positif', 'Central', 'Plutôt objectif', 95, 1, 0.58, 38.2, '${IWAC}102', 25, 0.39, 'fête - prière - ramadan', 'Positif', 'Central', 'Plutôt objectif', 'Positif', 'Très central', 'Mixte', 'Neutre', 'Central', 'Très objectif', 'Positif', 'Central', 'Plutôt objectif',
       'Positif', 'Central', 2.0, 'subjectivite', [0.05, 0.92, 0.08, 0.01]),
      ('103', 'iwac-103', 'La communauté musulmane célèbre la fin du ramadan', '',
       'Fraternité Matin', 'Côte d''Ivoire', '2010-11-01', 'Ramadan', 'Abidjan', 'Français',
       'Célébrations de la Korité à Abidjan.',
       'La Korité a été célébrée dans la joie à Abidjan. La communauté musulmane appelle à la paix.',
       'Très positif', 'Très central', 'Très objectif', 88, 1, 0.6, 40.0, '${IWAC}103', 25, 0.41, 'fête - prière - ramadan', 'Très positif', 'Très central', 'Très objectif', 'Neutre', 'Très central', 'Plutôt objectif', 'Positif', 'Très central', 'Très objectif', 'Positif', 'Très central', 'Très objectif',
       -- Polarity splits Très positif 2 / Positif 2 / Neutre 1: no majority, so
       -- the consensus is EMPTY and the dispute column says why. Centrality is
       -- unanimous on the same row, which is the point of storing them apart.
       '', 'Très central', 1.0, 'polarite|subjectivite', [0.02, 0.88, 0.12, 0.04]),
      ('104', 'iwac-104', 'L''islam au Niger : nouvelles associations', 'C. Issoufou',
       'Le Sahel', 'Niger', '2019-05-20', 'Islam', 'Niamey', 'Français',
       'Panorama des associations islamiques nigériennes.',
       'La communauté musulmane du Niger structure de nouvelles associations à Niamey.',
       -- deepseek leaves subjectivity empty here on purpose: the real model
       -- declines to score ~489 articles it did place on the other two scales,
       -- so a fixture where every row is scored would never exercise the
       -- unscored reconciliation. qwen leaves the row empty ENTIRELY, which is
       -- a different gap: not an abstention on one scale but 200 articles it
       -- never annotated at all, so this is the row that makes scored_by_all
       -- (5) smaller than the matched set (6).
       'Neutre', 'Secondaire', 'Mixte', 76, 1, 0.55, 37.1, '${IWAC}104', 6, 0.32, 'association - islam - organisation', 'Neutre', 'Secondaire', 'Mixte', 'Négatif', 'Marginal', '', 'Neutre', 'Marginal', 'Très objectif', '', '', '',
       -- The row qwen never annotated. Polarity is still decided, Neutre 3 of
       -- the 4 votes cast, so this article is in the consensus while being
       -- absent from agreement.scored_by_all. Centrality splits 2/2 with no
       -- majority; subjectivity still yields a median from luna and gemma.
       'Neutre', '', 3.0, 'centralite|subjectivite', [0.10, 0.15, 0.90, 0.03]),
      ('105', 'iwac-105', 'Dossier: le hadj expliqué', 'D. Lawson',
       'Togo-Presse', 'Togo', '1987-03-02', 'Pèlerinage', 'Lomé', 'Français',
       'Long dossier pédagogique sur le pèlerinage.',
       repeat('Le pèlerinage à La Mecque commence bientôt, selon les autorités locales. ', 450),
       -- The one row all FIVE models read the same way, so the unanimity path is
       -- still exercised rather than only the disagreement path.
       'Neutre', 'Central', 'Plutôt objectif', 32000, 4, 0.5, 35.0, '${IWAC}105', 12, 0.51, 'pèlerin - hadj - organisation_hadj', 'Neutre', 'Central', 'Plutôt objectif', 'Neutre', 'Central', 'Plutôt objectif', 'Neutre', 'Central', 'Plutôt objectif', 'Neutre', 'Central', 'Plutôt objectif',
       -- The one row all five read alike on every scale, so nothing is disputed
       -- and the dispute column is empty rather than absent.
       'Neutre', 'Central', 2.0, '', [0.86, 0.14, 0.02, 0.05]),
      ('106', 'iwac-106', 'Polémique autour d''une mosquée', '',
       'Le Matinal', 'Benin', '2001-09-14', 'Mosquée', 'Porto-Novo', 'Français',
       'Conflit foncier autour d''un projet de mosquée.',
       'La construction d''une mosquée à Porto-Novo suscite une vive polémique.',
       'Négatif', 'Très central', 'Plutôt subjectif', 102, 1, 0.61, 39.4, '${IWAC}106', 12, 0.28, 'imam - mosquée - prière', 'Négatif', 'Très central', 'Plutôt subjectif', 'Très négatif', 'Très central', 'Très subjectif', 'Négatif', 'Très central', 'Plutôt subjectif', 'Négatif', 'Très central', 'Plutôt subjectif',
       'Négatif', 'Très central', 4.0, 'subjectivite', [0.08, 0.20, 0.85, 0.09]);
  `,

  publications: `
    CREATE TABLE publications (
      "o:id" VARCHAR, title VARCHAR, newspaper VARCHAR, country VARCHAR,
      pub_date VARCHAR, language VARCHAR, subject VARCHAR, nb_pages BIGINT,
      "tableOfContents" VARCHAR, "OCR" VARCHAR, iwac_url VARCHAR
    );
    INSERT INTO publications VALUES
      ('201', 'Islam Info n°1', 'Islam Info', 'Côte d''Ivoire', '1998', 'Français',
       'Ramadan', 12, '',
       'Dossier spécial ramadan : ferveur et solidarité à Abidjan.', '${IWAC}201'),
      ('202', 'Al Maoulid — numéro inaugural', 'Al Maoulid', 'Benin', '1912', 'Français',
       '', 8, '',
       'La charia et la vie quotidienne des fidèles, un débat ancien.', '${IWAC}202'),
      ('203', 'La Voix de l''Islam n°3', 'La Voix de l''Islam', 'Burkina Faso', '1995-06-01', 'Français',
       'Pèlerinage|Laïcité', 16,
       'Editorial: la laïcité en question' || chr(10) || chr(10) || 'Dossier: le pèlerinage à La Mecque',
       'Le pèlerinage à La Mecque, cinquième pilier de l''islam, expliqué à nos lecteurs.', '${IWAC}203');
  `,

  references: `
    CREATE TABLE "references" (
      "o:id" VARCHAR, identifier VARCHAR, title VARCHAR, author VARCHAR, editor VARCHAR,
      type VARCHAR, "o:resource_class" VARCHAR, pub_date VARCHAR, publisher VARCHAR,
      book_title VARCHAR, chapter VARCHAR, volume VARCHAR, issue VARCHAR,
      page_start VARCHAR, page_end VARCHAR, nb_pages BIGINT, edition VARCHAR, extent VARCHAR,
      abstract VARCHAR, subject VARCHAR, spatial VARCHAR, language VARCHAR, country VARCHAR,
      doi VARCHAR, "URL" VARCHAR, is_part_of VARCHAR, review_of VARCHAR, provenance VARCHAR,
      iwac_url VARCHAR
    );
    INSERT INTO "references" VALUES
      ('301', 'ref-301', 'Muslim Politics across Northern Nigeria and Niger', 'Smith, John', '',
       'Article de revue', 'Article de revue', '2015', '', '', '', '12', '3', '201', '229', 0, '', '',
       'This article surveys Muslim political mobilisation across the Niger–Nigeria borderlands. Drawing on fieldwork in Maradi, Kano and Zinder, it traces how reformist movements, Sufi orders and state institutions negotiated authority between 1990 and 2010, and argues that cross-border religious networks shaped electoral politics on both sides in ways national frames systematically miss, with lasting consequences for how sharia debates travelled.',
       '', 'Maradi|Kano', 'Anglais', 'Niger|Nigeria', '10.1000/test-301', '', 'Journal of West African Studies', '', '', '${IWAC}301'),
      ('302', 'ref-302', 'L''islam au Bénin : histoire et société', 'Kadiri, Aïcha', '',
       'Livre', 'Livre', '1999', 'Éditions du Golfe', '', '', '', '', '', '', 240, '1re', '',
       'Synthèse historique sur les communautés musulmanes béninoises.',
       'Islam', 'Cotonou', 'Français', 'Benin', '', '', '', '', '', '${IWAC}302'),
      ('303', 'ref-303', 'Confréries et politique au Togo', 'Mensah, Paul', 'Doe, Jane',
       'Chapitre de livre', 'Chapitre de livre', '2005', 'Academia', 'Religions ouest-africaines', '7',
       '', '', '145', '168', 0, '', '',
       'Le chapitre analyse le rôle des confréries soufies dans la vie politique togolaise.',
       'Confréries', 'Lomé', 'Français', 'Togo', '', '', '', '', '', '${IWAC}303'),
      ('304', 'ref-304', 'Sharia Implementation in Northern Nigeria', 'Adamu, Bello', '',
       'Rapport', 'Rapport', '2003', 'Policy Institute', '', '', '', '', '', '', 88, '', '',
       'Report on the first years of sharia implementation across twelve northern Nigerian states.',
       '', 'Kano', 'Anglais', 'Nigeria', '', 'https://example.org/report-304', '', '', '', '${IWAC}304');
  `,

  documents: `
    CREATE TABLE documents (
      "o:id" VARCHAR, identifier VARCHAR, title VARCHAR, author VARCHAR, country VARCHAR,
      pub_date VARCHAR, type VARCHAR, subject VARCHAR, spatial VARCHAR, language VARCHAR,
      nb_pages BIGINT, source VARCHAR, rights VARCHAR, "descriptionAI" VARCHAR,
      nb_mots BIGINT, "OCR" VARCHAR, iwac_url VARCHAR
    );
    INSERT INTO documents VALUES
      ('501', 'doc-501', 'Rapport annuel de l''AEEMB', 'AEEMB', 'Burkina Faso', '1994-01-01',
       'Rapport', 'Association|Éducation', 'Ouagadougou', 'Français', 24, 'Archives AEEMB', '',
       'Rapport d''activités annuel de l''association des élèves et étudiants musulmans du Burkina.',
       850, 'L''association des élèves et étudiants musulmans du Burkina dresse le bilan de l''année : camps de formation, prêches et actions sociales.', '${IWAC}501'),
      ('502', 'doc-502', 'Tract de la communauté musulmane de Lomé', '', 'Togo', '1990',
       'Tract', 'Mosquée', 'Lomé', 'Français', 2, '', '',
       'Tract appelant à la solidarité pour la construction d''une mosquée.',
       210, 'Appel aux fidèles : contribuez à la construction de la nouvelle mosquée centrale de Lomé.', '${IWAC}502');
  `,

  audiovisual: `
    CREATE TABLE audiovisual (
      "o:id" VARCHAR, identifier VARCHAR, added_date VARCHAR, iwac_url VARCHAR,
      iiif_manifest VARCHAR, "PDF" VARCHAR, thumbnail VARCHAR, "URL" VARCHAR,
      source_type VARCHAR, title VARCHAR,
      creator VARCHAR, publisher VARCHAR, country VARCHAR, pub_date VARCHAR,
      description VARCHAR, "descriptionAI" VARCHAR, volume VARCHAR, issue VARCHAR,
      is_part_of VARCHAR, extent VARCHAR, duration_seconds BIGINT, medium VARCHAR,
      type VARCHAR, rights VARCHAR, contributor VARCHAR, subject VARCHAR,
      spatial VARCHAR, language VARCHAR, source VARCHAR, "OCR" VARCHAR
    );
    -- ONE class, TWO populations, and the fixture must carry both or the server's
    -- audiovisual contract is only half tested (issue #20):
    --
    --   deposited (601, 602) — a real file in "PDF"/iiif, a creator, a physical
    --     carrier, and Nigerian Hausa/Arabic content. 47 rows in the corpus.
    --   youtube   (603)      — NO file at all: the media holds a thumbnail
    --     derivative only, so "PDF" and iiif_manifest are empty and the video
    --     lives at its "URL". No creator; the publisher is the CHANNEL. 1,724
    --     rows in the corpus and climbing.
    --
    -- Getting this split wrong is not hypothetical: while the fixture held two
    -- deposited Nigerian rows, country="Burkina Faso" and every YouTube-shaped
    -- assumption passed the hermetic suite by never being exercised.
    --
    -- descriptionAI is empty for ALL rows, mirroring the real subset (0/1,771
    -- filled); description is the item's own blurb and, for 602 and 603, its
    -- ONLY text — the post-harvest majority case (1,465 of 1,771 rows carry one;
    -- 50 carry a transcription). 601 has both, so the rows cover the fetch body
    -- order: transcription wins where there is one, description stands in where
    -- not. medium carries the dataset's real carrier vocabulary (MEDIUM_VALUES),
    -- not the "audio"/"video" modality words this fixture used to invent — a
    -- fixture that agrees with itself but not with the corpus is how the medium
    -- filter shipped validating against values no row could ever hold.
    -- extent is an ISO-8601 duration, as in the parquet ("PT58M", not "58 min").
    INSERT INTO audiovisual VALUES
      ('601', 'av-601', '2023-05-01', '${IWAC}601', 'https://islam.zmo.de/iiif/3/601/manifest',
       'https://example.org/media/601.mp3', '', '', 'deposited',
       'Tafsir du Ramadan à Kano', 'Sheikh Abubakar', 'Radio Kano', 'Nigeria', '2020-04-25',
       'Sheikh Abubakar explains the fasting rules that apply to a traveller.|Sheikh Abubakar ya bayyana hukuncin azumi ga matafiyi.',
       '', '', '', 'Série Tafsir', 'PT58M', 3480, 'CD',
       'Enregistrement vidéo', 'In Copyright - Rights-Holder(s) Unlocatable or Unidentifiable',
       'Aleksei Akseshin|Vincent Favier', 'Ramadan|Tafsir', 'Kano', 'Haoussa', 'Radio Kano',
       'Bismillah. Sannu da zuwa. Tafsirin yau yana magana kan azumin Ramadan da sadaka.'),
      ('602', 'av-602', '2023-06-12', '${IWAC}602', '', 'https://example.org/media/602.mp4', '', '', 'deposited',
       'Friday sermon in Abuja', 'Imam Yusuf', '', 'Nigeria', '2021-06-11',
       'Retransmission intégrale du prêche, suivie d''un appel à la concorde entre les communautés.',
       '', '', '', '', 'PT41M', 2460, 'DVD',
       'Enregistrement vidéo', 'In Copyright - Rights-Holder(s) Unlocatable or Unidentifiable',
       'Aleksei Akseshin|Vincent Favier', 'Prêche', 'Abuja', 'Arabe|Anglais', '', ''),
      -- The harvested cohort: Burkinabè, francophone, no file, no creator, no
      -- transcription — reachable only by title, channel and its own blurb.
      ('603', 'av-603', '2024-05-21', '${IWAC}603', '', '',
       'https://islam.zmo.de/files/medium/603.jpg', 'https://www.youtube.com/watch?v=xcGWG5msEEs', 'youtube',
       'FAIB : installation du nouveau président', '',
       'RTB - Radiodiffusion Télévision du Burkina', 'Burkina Faso', '2024-05-20',
       'La Fédération des associations islamiques du Burkina a installé son nouveau bureau à Ouagadougou, en présence des responsables coutumiers et religieux.',
       '', '', '', '', 'PT6M51S', 411, 'Vidéo sur le web',
       'Enregistrement vidéo', 'In Copyright', 'Frédérick Madore', '', 'Ouagadougou', 'Français', '', '');
  `,

  images: `
    CREATE TABLE images (
      "o:id" VARCHAR, identifier VARCHAR, added_date VARCHAR, iwac_url VARCHAR,
      iiif_manifest VARCHAR, image_url VARCHAR, thumbnail VARCHAR, title VARCHAR,
      type VARCHAR, creator VARCHAR, pub_date VARCHAR, description VARCHAR,
      rights VARCHAR, subject VARCHAR, spatial VARCHAR, coordinates VARCHAR, country VARCHAR
    );
    -- description is empty for 2 of 3 rows, as in the real subset (2/30 filled):
    -- discovery here runs on title/creator/subject/place, not on captions.
    INSERT INTO images VALUES
      ('701', 'iwac-image-0000001', '2024-03-16', '${IWAC}701',
       'https://islam.zmo.de/iiif/3/701/manifest', 'https://example.org/files/701.jpeg',
       'https://example.org/files/medium/701.jpg', 'Radio Ridwane', 'Photographie',
       'Frédérick Madore', '2015-04-16', '', 'In Copyright - Educational Use Permitted',
       'Radio Ridwane', 'Ouagadougou', '12.3367681, -1.5436187', 'Burkina Faso'),
      ('702', 'iwac-image-0000002', '2024-03-16', '${IWAC}702',
       '', 'https://example.org/files/702.jpeg', '', 'Grande mosquée de Lomé', 'Photographie',
       'Frédérick Madore', '2018-11-02', 'Façade de la grande mosquée un vendredi.',
       'In Copyright - Educational Use Permitted', 'Mosquée', 'Lomé', '6.1319, 1.2228', 'Togo'),
      ('703', 'iwac-image-0000003', '2024-05-20', '${IWAC}703',
       '', 'https://example.org/files/703.jpeg', '', 'École coranique de Cotonou', 'Photographie',
       'A. Dossou', '2019-02-11', '', 'In Copyright - Educational Use Permitted',
       'Éducation|Enseignement islamique', 'Cotonou', '6.3703, 2.3912', 'Benin');
  `,

  index: `
    CREATE TABLE "index" (
      "o:id" BIGINT, "Titre" VARCHAR, "Titre alternatif" VARCHAR, "Type" VARCHAR,
      "Description" VARCHAR, frequency BIGINT, first_occurrence VARCHAR,
      last_occurrence VARCHAR, countries VARCHAR, iwac_url VARCHAR
    );
    INSERT INTO "index" VALUES
      (401, 'Bénin', 'Dahomey', 'Lieux', 'Pays d''Afrique de l''Ouest.', 500, '1987-03-02', '2019-05-20', 'Benin|Togo', '${IWAC}401'),
      (402, 'Ouagadougou', '', 'Lieux', 'Capitale du Burkina Faso.', 300, '1994-01-01', '2003-01-10', 'Burkina Faso', '${IWAC}402'),
      (403, 'El Hadj Omar Tall', 'Omar Tall', 'Personnes', 'Chef religieux toucouleur du XIXe siècle.', 120, '1987-03-02', '2010-11-01', 'Benin', '${IWAC}403'),
      (404, 'Pèlerinage à La Mecque', 'Hadj', 'Sujets', 'Cinquième pilier de l''islam.', 800, '1987-03-02', '2019-05-20', 'Benin|Burkina Faso', '${IWAC}404'),
      (405, 'Ramadan', '', 'Sujets', 'Mois de jeûne musulman.', 600, '1995-06-15', '2021-06-11', 'Benin|Côte d''Ivoire', '${IWAC}405'),
      (406, 'Conférence islamique de 1995', '', 'Événements', 'Rencontre nationale des associations islamiques.', 50, '1995-06-01', '1995-06-15', 'Togo', '${IWAC}406'),
      (407, 'Communauté Musulmane du Burkina', 'CMBF', 'Organisations', 'Faîtière des associations musulmanes burkinabè.', 90, '1994-01-01', '2003-01-10', 'Burkina Faso', '${IWAC}407');
  `,
};

async function main() {
  await fs.rm(fixturesDir, { recursive: true, force: true });
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();

  for (const [subset, sql] of Object.entries(SUBSET_SQL)) {
    await conn.run(sql);
    const table = subset === "index" || subset === "references" ? `"${subset}"` : subset;
    // The PUBLIC dataset masks full text per row: `OCR_is_public` mirrors
    // whether the source content is public on islam.zmo.de, and `OCR` is blank
    // wherever it is false. Derive the flag from the fixture text so the two can
    // never disagree, then mask one article so `fulltext_coverage` has something
    // to report other than a flat 100%.
    if (OCR_SUBSETS.includes(subset)) {
      if (subset === "articles") {
        await conn.run(`UPDATE articles SET "OCR" = '' WHERE "o:id" = '104'`);
      }
      await conn.run(`ALTER TABLE ${table} ADD COLUMN "OCR_is_public" BOOLEAN`);
      await conn.run(`UPDATE ${table} SET "OCR_is_public" = length(trim(coalesce("OCR", ''))) > 0`);
    }
    // The English half of the bilingual AI summary. Empty string, not NULL,
    // for rows without one — the real parquet stores empty strings here, and a
    // NULL would let a `COUNT()` claim coverage the subset does not have.
    if (DESC_AI_SUBSETS.includes(subset)) {
      await conn.run(`ALTER TABLE ${table} ADD COLUMN "descriptionAI_en" VARCHAR`);
      await conn.run(`UPDATE ${table} SET "descriptionAI_en" = ''`);
      for (const [oid, text] of Object.entries(DESC_AI_EN)) {
        await conn.run(
          `UPDATE ${table} SET "descriptionAI_en" = '${text.replace(/'/g, "''")}'
           WHERE "o:id" = '${oid}'`,
        );
      }
    }
    // Hijri columns, keyed off pub_date exactly as the pipeline does. Rows whose
    // date is not a complete YYYY-MM-DD (year-only, or a `1981-04/1981-06`
    // range) are left NULL — an imprecise date has no lunar day, and that
    // absence is a case the tools have to report rather than plot.
    if (HIJRI_SUBSETS.includes(subset)) {
      // DOUBLE, not BIGINT, because that is what the real parquet stores — and
      // the difference is not cosmetic. `CAST(3 AS VARCHAR)` is '3' but
      // `CAST(3.0 AS VARCHAR)` is '3.0', so a fixture typed BIGINT renders
      // every Hijri bucket and date correctly no matter how the SQL is written,
      // and cannot reproduce a whole class of formatting bug that production
      // hits on every row. It hid exactly that once already.
      for (const col of ["hijri_year", "hijri_month", "hijri_day"]) {
        await conn.run(`ALTER TABLE ${table} ADD COLUMN "${col}" DOUBLE`);
      }
      for (const [greg, [hy, hm, hd]] of Object.entries(HIJRI)) {
        await conn.run(
          `UPDATE ${table} SET "hijri_year" = ${hy}, "hijri_month" = ${hm}, "hijri_day" = ${hd}
           WHERE pub_date = '${greg}'`,
        );
      }
    }
    const dir = path.join(fixturesDir, subset);
    await fs.mkdir(dir, { recursive: true });
    const dest = path.join(dir, "train-00000-of-00001.parquet").replaceAll("\\", "/");
    await conn.run(`COPY (SELECT * FROM ${table}) TO '${dest.replace(/'/g, "''")}' (FORMAT PARQUET)`);
  }
  console.log(`fixtures written to ${fixturesDir}`);
}

main().catch((err) => {
  console.error("make-fixtures failed:", err);
  process.exit(1);
});
