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

/** One CREATE + INSERT block per subset (plain SQL keeps the data reviewable). */
const SUBSET_SQL = {
  articles: `
    CREATE TABLE articles (
      "o:id" VARCHAR, identifier VARCHAR, title VARCHAR, author VARCHAR,
      newspaper VARCHAR, country VARCHAR, pub_date VARCHAR, subject VARCHAR,
      spatial VARCHAR, language VARCHAR, "descriptionAI" VARCHAR, "OCR" VARCHAR,
      gemini_polarite VARCHAR, gemini_centralite_islam_musulmans VARCHAR,
      gemini_subjectivite_score DOUBLE, nb_mots BIGINT, nb_pages BIGINT,
      "Richesse_Lexicale_OCR" DOUBLE, "Lisibilite_OCR" DOUBLE, iwac_url VARCHAR,
      -- LDA topics and the two further sentiment models, so the aggregate
      -- tools have something to aggregate. Subjectivity is an INTEGER 1-5
      -- rating in the real parquet, not a 0-1 proportion — the fixture matches
      -- that, because a tool which ships the scale must be tested against it.
      lda_topic_id DOUBLE, lda_topic_prob DOUBLE, lda_topic_label VARCHAR,
      chatgpt_polarite VARCHAR, chatgpt_centralite_islam_musulmans VARCHAR,
      chatgpt_subjectivite_score DOUBLE,
      mistral_polarite VARCHAR, mistral_centralite_islam_musulmans VARCHAR,
      mistral_subjectivite_score DOUBLE
    );
    INSERT INTO articles VALUES
      ('101', 'iwac-101', 'Le pèlerinage à La Mecque vu de Cotonou', 'A. Dossou',
       'La Nation', 'Benin', '1995-06-15', 'Pèlerinage|Religion', 'Cotonou|La Mecque', 'Français',
       'Reportage sur le départ des pèlerins béninois pour La Mecque.',
       'Cette année encore, le pèlerinage à La Mecque mobilise des centaines de fidèles depuis Cotonou. Les autorités saluent l''organisation du hadj.',
       'Neutre', 'Central', 2, 120, 1, 0.62, 41.5, '${IWAC}101', 12, 0.47, 'pèlerin - hadj - organisation_hadj', 'Neutre', 'Central', 2, 'Positif', 'Central', 2),
      ('102', 'iwac-102', 'Ramadan à Ouagadougou', 'B. Ouedraogo',
       'Sidwaya', 'Burkina Faso', '2003-01-10', 'Mosquée|Ramadan', 'Ouagadougou', 'Français',
       'Le mois de jeûne vécu dans les mosquées de la capitale burkinabè.',
       'Le ramadan à Ouagadougou rassemble les fidèles dans les mosquées chaque soir.',
       'Positif', 'Central', 2, 95, 1, 0.58, 38.2, '${IWAC}102', 25, 0.39, 'fête - prière - ramadan', 'Positif', 'Central', 2, 'Positif', 'Très central', 3),
      ('103', 'iwac-103', 'La communauté musulmane célèbre la fin du ramadan', '',
       'Fraternité Matin', 'Côte d''Ivoire', '2010-11-01', 'Ramadan', 'Abidjan', 'Français',
       'Célébrations de la Korité à Abidjan.',
       'La Korité a été célébrée dans la joie à Abidjan. La communauté musulmane appelle à la paix.',
       'Très positif', 'Très central', 1, 88, 1, 0.6, 40.0, '${IWAC}103', 25, 0.41, 'fête - prière - ramadan', 'Très positif', 'Très central', 1, 'Positif', 'Très central', 2),
      ('104', 'iwac-104', 'L''islam au Niger : nouvelles associations', 'C. Issoufou',
       'Le Sahel', 'Niger', '2019-05-20', 'Islam', 'Niamey', 'Français',
       'Panorama des associations islamiques nigériennes.',
       'La communauté musulmane du Niger structure de nouvelles associations à Niamey.',
       'Neutre', 'Secondaire', 3, 76, 1, 0.55, 37.1, '${IWAC}104', 6, 0.32, 'association - islam - organisation', 'Neutre', 'Secondaire', 3, 'Négatif', 'Marginal', 3),
      ('105', 'iwac-105', 'Dossier: le hadj expliqué', 'D. Lawson',
       'Togo-Presse', 'Togo', '1987-03-02', 'Pèlerinage', 'Lomé', 'Français',
       'Long dossier pédagogique sur le pèlerinage.',
       repeat('Le pèlerinage à La Mecque commence bientôt, selon les autorités locales. ', 450),
       'Neutre', 'Central', 2, 32000, 4, 0.5, 35.0, '${IWAC}105', 12, 0.51, 'pèlerin - hadj - organisation_hadj', 'Neutre', 'Central', 2, 'Neutre', 'Central', 2),
      ('106', 'iwac-106', 'Polémique autour d''une mosquée', '',
       'Le Matinal', 'Benin', '2001-09-14', 'Mosquée', 'Porto-Novo', 'Français',
       'Conflit foncier autour d''un projet de mosquée.',
       'La construction d''une mosquée à Porto-Novo suscite une vive polémique.',
       'Négatif', 'Très central', 4, 102, 1, 0.61, 39.4, '${IWAC}106', 12, 0.28, 'imam - mosquée - prière', 'Négatif', 'Très central', 4, 'Très négatif', 'Très central', 5);
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
      iiif_manifest VARCHAR, "PDF" VARCHAR, thumbnail VARCHAR, title VARCHAR,
      creator VARCHAR, publisher VARCHAR, country VARCHAR, pub_date VARCHAR,
      "descriptionAI" VARCHAR, volume VARCHAR, issue VARCHAR, is_part_of VARCHAR,
      extent VARCHAR, medium VARCHAR, subject VARCHAR, spatial VARCHAR,
      language VARCHAR, source VARCHAR, "OCR" VARCHAR
    );
    -- descriptionAI is empty for BOTH rows, mirroring the real subset (0/47
    -- filled); the transcription in "OCR" is the only text these items have.
    INSERT INTO audiovisual VALUES
      ('601', 'av-601', '2023-05-01', '${IWAC}601', '', 'https://example.org/media/601.mp3', '',
       'Tafsir du Ramadan à Kano', 'Sheikh Abubakar', 'Radio Kano', 'Nigeria', '2020-04-25',
       '', '', '', 'Série Tafsir', '58 min', 'audio', 'Ramadan|Tafsir', 'Kano', 'Haoussa', 'Radio Kano',
       'Bismillah. Sannu da zuwa. Tafsirin yau yana magana kan azumin Ramadan da sadaka.'),
      ('602', 'av-602', '2023-06-12', '${IWAC}602', '', 'https://example.org/media/602.mp4', '',
       'Friday sermon in Abuja', 'Imam Yusuf', '', 'Nigeria', '2021-06-11',
       '', '', '', '', '41 min', 'video', 'Prêche', 'Abuja', 'Arabe|Anglais', '', '');
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
