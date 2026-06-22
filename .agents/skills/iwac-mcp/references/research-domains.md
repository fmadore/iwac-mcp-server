# IWAC Research Domains and Search Terms

Key research domains covered by IWAC, with French search terms and transliteration variants. Use these as starting points for Phase 2 systematic searches.

Server matching is **accent- and case-insensitive** (v0.6.0+), so `pelerinage` and `pèlerinage` return the same results — but write proper French in research outputs, and keep trying *spelling* variants (transliterations differ; accents don't matter, letters do).

## 1. Islamic Organizations and Associations

| Search Term | Context |
|------------|---------|
| communauté musulmane | Generic term for Muslim community |
| association islamique | Islamic associations |
| FAIB | Fédération des Associations Islamiques du Burkina |
| AEEMB | Association des Élèves et Étudiants Musulmans au Burkina |
| CERFI | Cercle d'Études, de Recherches et de Formation Islamiques (BF) |
| AEEMCI | Association des Élèves et Étudiants Musulmans de Côte d'Ivoire |
| CNI | Conseil National Islamique (CI) |
| COSIM | Conseil Supérieur des Imams (CI) |
| Jama'at, Jamaat | Islamic congregations/movements |
| conseil islamique | Islamic councils |
| fédération musulmane | Muslim federations |
| union islamique | Islamic unions |

## 2. Islamic Education

| Search Term | Context |
|------------|---------|
| madrasa, médersa | Quranic/Islamic schools (French spelling variants) |
| école coranique | Quranic school |
| arabophone | Arabic-language education |
| enseignement islamique | Islamic education |
| enseignement arabe | Arabic-language instruction |
| université islamique | Islamic university |
| formation islamique | Islamic training |
| alphabétisation | Literacy programs (often in Arabic) |
| franco-arabe | Franco-Arabic schools |

## 3. Religious Practice and Festivals

| Search Term | Transliteration Variants |
|------------|-------------------------|
| Ramadan | Ramadan, Carême musulman |
| Tabaski | Aïd el-Kébir, Eid al-Adha, fête du mouton |
| Aïd el-Fitr | Korité, fête de Ramadan |
| Maouloud | Mouloud, Maoulid, Mawlid, naissance du Prophète |
| prière | Salat, namaz |
| mosquée | lieu de culte, grande mosquée |
| pèlerinage | Hadj, Hajj, Mecque |
| imam | guide religieux, chef religieux |
| muezzin | appel à la prière |
| zakat | aumône, dîme |
| waqf | biens de mainmorte |
| halal | licite, norme islamique |

## 4. Interfaith Relations

| Search Term | Context |
|------------|---------|
| dialogue interreligieux | Interfaith dialogue |
| chrétien, chrétiens | Christian references |
| vodou, vaudou | Traditional religions (Benin/Togo) |
| laïcité | Secularism |
| tolérance religieuse | Religious tolerance |
| cohabitation religieuse | Religious coexistence |
| conflit religieux | Religious conflict |
| conversion | Religious conversion |
| animisme | Traditional beliefs |
| œcuménisme | Ecumenism (also spelled oecuménisme) |

## 5. Women and Islam

| Search Term | Context |
|------------|---------|
| femme musulmane | Muslim women |
| voile, hijab | Veiling |
| excision | FGM (frequently discussed in Islamic context) |
| mariage islamique | Islamic marriage |
| polygamie | Polygamy |
| dot | Bride price/dowry |
| divorce | Divorce |
| droit de la femme | Women's rights |
| association féminine musulmane | Muslim women's associations |

## 6. Youth and Islam

| Search Term | Context |
|------------|---------|
| jeunesse musulmane | Muslim youth |
| étudiant musulman | Muslim students |
| AEEMB, AEEMCI | Student Islamic associations |
| mouvement étudiant | Student movements |
| jeunes et islam | Youth and Islam |

## 7. Islam and Politics / Security

| Search Term | Context |
|------------|---------|
| charia, chari'a | Sharia |
| islamisme | Islamism |
| radicalisation | Radicalization |
| terrorisme | Terrorism |
| sécurité | Security |
| extrémisme | Extremism |
| djihadisme, jihad | Jihadism |
| Boko Haram | Specific movement |
| Sahel | Regional security context |
| wahhabisme, salafisme | Reformist movements |
| fondamentalisme | Fundamentalism |
| intégrisme | Fundamentalism/integrism |

## 8. Islamic Media

| Search Term | Context |
|------------|---------|
| journal islamique | Islamic newspapers |
| radio islamique | Islamic radio stations |
| prêche, prédication | Preaching |
| média musulman | Muslim media |
| presse islamique | Islamic press |
| télévision islamique | Islamic TV |

## 9. Hajj and Pilgrimage

| Search Term | Variants |
|------------|---------|
| pèlerinage | Hadj, Hajj |
| Mecque | La Mecque, Makkah |
| Arabie saoudite | Saudi Arabia |
| pèlerins | Pilgrims |
| billet d'avion | Travel logistics (common in coverage) |
| organisation du Hadj | Hajj organization/logistics |
| Médine | Madinah, Medina |

## 10. Islamic Finance and Economy

| Search Term | Context |
|------------|---------|
| zakat | Islamic alms/tax |
| waqf | Islamic endowments |
| banque islamique | Islamic banking |
| commerce musulman | Muslim commerce |
| finance islamique | Islamic finance |
| économie musulmane | Muslim economy |

## 11. Islam and Health

| Search Term | Context |
|------------|---------|
| islam et santé | Islam and health |
| médecine traditionnelle | Traditional medicine |
| VIH, SIDA | HIV/AIDS (frequently discussed in Islamic context) |
| vaccination | Vaccination campaigns |
| guérisseur | Traditional healers |
| islam et pandémie | Islam and pandemic |

## 12. Islamic Architecture and Heritage

| Search Term | Context |
|------------|---------|
| mosquée | Mosque construction/architecture |
| patrimoine islamique | Islamic heritage |
| architecture islamique | Islamic architecture |
| cimetière musulman | Muslim cemetery |
| lieu saint | Holy site |

---

## Search Strategy Notes

- **Keyword search terms must be French for primary-source subsets** — develop keyword terms in French ("pèlerinage", "éducation", "terrorisme"), not English, even when the user asks in another language. Academic references are multilingual: search titles/abstracts with French and English concept terms when relevant, while keeping metadata/filter values in French. Semantic embedding queries may be in any language.
- **Accents and case don't affect matching** (server ≥ 0.6.0). Spelling still does: try transliteration variants (madrasa/médersa, Maouloud/Mouloud/Mawlid).
- **Country filters take exact names:** Benin, Burkina Faso, Côte d'Ivoire, Niger, Togo (+ Nigeria for references/index/audiovisual). Partial names return nothing.
- **Start broad, then narrow:** begin with a general term (e.g., "madrasa"), then add country or date filters.
- **Check the index first:** use `search_index` to find the canonical form of a person/organization name, then search articles with that exact form.
- **Prefer `subject` over `keyword`** for known thematic categories: `keyword` searches title + OCR + AI abstract; `subject` searches the curated tags (which may use different terminology than the OCR text). Discover tags via `list_subjects`.
- **Islamic publications vs. mainstream press:** `search_publications` covers Islamic community media (Islam Info, An-Nasr Vendredi, …). Most items are entire issues — navigate by series (`list_periodicals`), subject (87% tagged), country and year; keyword also matches tables of contents (17 of 25 series have them, returned as `matching_toc_entries`); use `get_publication_fulltext` keyword excerpts to read inside an issue.
- **State press vs. private press:** pre-1991 articles come almost entirely from state/single-party organs, and some outlets changed names across regimes (Ehuzu → La Nation; Togo-Presse ↔ La Nouvelle Marche; L'Observateur → L'Observateur Paalga) — search all name variants when following one outlet across time (see biases-and-limitations.md §6).
- **Temporal filtering:** articles take `YYYY-MM-DD` or `YYYY`; publications/references take years.
