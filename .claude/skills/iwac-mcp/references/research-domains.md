# IWAC Research Domains and Search Terms

Key research domains covered by IWAC, with French search terms and transliteration variants. Use these as starting points for Phase 2 systematic searches.

## 1. Islamic Organizations and Associations

| Search Term | Context |
|------------|---------|
| communaute musulmane | Generic term for Muslim community |
| association islamique | Islamic associations |
| FAIB | Federation des Associations Islamiques du Burkina |
| AEEMB | Association des Eleves et Etudiants Musulmans du Burkina |
| CERFI | Cercle d'Etudes, de Recherches et de Formation Islamiques (BF) |
| AEEMCI | Association des Eleves et Etudiants Musulmans de Cote d'Ivoire |
| CNI | Conseil National Islamique (CI) |
| COSIM | Conseil Superieur des Imams (CI) |
| Jama'at, Jamaat | Islamic congregations/movements |
| conseil islamique | Islamic councils |
| federation musulmane | Muslim federations |
| union islamique | Islamic unions |

## 2. Islamic Education

| Search Term | Context |
|------------|---------|
| madrasa, medersa | Quranic/Islamic schools (French spelling variants) |
| ecole coranique | Quranic school |
| arabophone | Arabic-language education |
| enseignement islamique | Islamic education |
| enseignement arabe | Arabic-language instruction |
| universite islamique | Islamic university |
| formation islamique | Islamic training |
| alphabetisation | Literacy programs (often in Arabic) |
| franco-arabe | Franco-Arabic schools |

## 3. Religious Practice and Festivals

| Search Term | Transliteration Variants |
|------------|-------------------------|
| Ramadan | Ramadan, Careme musulman |
| Tabaski | Aid el-Kebir, Eid al-Adha, fete du mouton |
| Aid el-Fitr | Korite, fete de Ramadan |
| Maouloud | Mouloud, Maoulid, Mawlid, naissance du Prophete |
| priere | Salat, namaz |
| mosquee | lieu de culte, grande mosquee |
| pelerinage | Hadj, Hajj, Mecque |
| imam | Guide religieux, chef religieux |
| muezzin | Appel a la priere |
| zakat | Aumone, dime |
| waqf | Biens de mainmorte |
| halal | Licite, norme islamique |

## 4. Interfaith Relations

| Search Term | Context |
|------------|---------|
| dialogue interreligieux | Interfaith dialogue |
| chretien, chretiens | Christian references |
| vodou, vaudou | Traditional religions (Benin/Togo) |
| laicite | Secularism |
| tolerance religieuse | Religious tolerance |
| cohabitation religieuse | Religious coexistence |
| conflit religieux | Religious conflict |
| conversion | Religious conversion |
| animisme | Traditional beliefs |
| oecumenisme | Ecumenism |

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
| association feminine musulmane | Muslim women's associations |

## 6. Youth and Islam

| Search Term | Context |
|------------|---------|
| jeunesse musulmane | Muslim youth |
| etudiant musulman | Muslim students |
| AEEMB, AEEMCI | Student Islamic associations |
| mouvement etudiant | Student movements |
| jeunes et islam | Youth and Islam |

## 7. Islam and Politics / Security

| Search Term | Context |
|------------|---------|
| charia, chari'a | Sharia |
| islamisme | Islamism |
| radicalisation | Radicalization |
| terrorisme | Terrorism |
| securite | Security |
| extremisme | Extremism |
| djihadisme, jihad | Jihadism |
| Boko Haram | Specific movement |
| Sahel | Regional security context |
| wahhabisme, salafisme | Reformist movements |
| fondamentalisme | Fundamentalism |
| integralisme | Integralism |

## 8. Islamic Media

| Search Term | Context |
|------------|---------|
| journal islamique | Islamic newspapers |
| radio islamique | Islamic radio stations |
| preche, predication | Preaching |
| media musulman | Muslim media |
| presse islamique | Islamic press |
| television islamique | Islamic TV |

## 9. Hajj and Pilgrimage

| Search Term | Variants |
|------------|---------|
| pelerinage | Hadj, Hajj |
| Mecque | La Mecque, Makkah |
| Arabie saoudite | Saudi Arabia |
| pelerins | Pilgrims |
| billet d'avion | Travel logistics (common in coverage) |
| organisation du Hadj | Hajj organization/logistics |
| Medine | Madinah, Medina |

## 10. Islamic Finance and Economy

| Search Term | Context |
|------------|---------|
| zakat | Islamic alms/tax |
| waqf | Islamic endowments |
| banque islamique | Islamic banking |
| commerce musulman | Muslim commerce |
| finance islamique | Islamic finance |
| economie musulmane | Muslim economy |

## 11. Islam and Health

| Search Term | Context |
|------------|---------|
| islam et sante | Islam and health |
| medecine traditionnelle | Traditional medicine |
| VIH, SIDA | HIV/AIDS (frequently discussed in Islamic context) |
| vaccination | Vaccination campaigns |
| guerisseur | Traditional healers |
| Islam et pandemie | Islam and pandemic |

## 12. Islamic Architecture and Heritage

| Search Term | Context |
|------------|---------|
| mosquee | Mosque construction/architecture |
| patrimoine islamique | Islamic heritage |
| architecture islamique | Islamic architecture |
| cimetiere musulman | Muslim cemetery |
| lieu saint | Holy site |

---

## Search Strategy Notes

- **ALL searches must be in French.** Never use English terms (e.g., "pilgrimage", "education", "terrorism"). Always translate to French: "pèlerinage", "éducation", "terrorisme". The collection has no English-language indexing.
- **Use `Côte d'Ivoire` with the accent** (circumflex ô). Without it, the country filter returns 0 results.
- **Start broad, then narrow:** Begin with a general term (e.g., "madrasa"), then add country or date filters
- **Try multiple variants:** French transliteration of Arabic terms varies significantly across countries and time periods
- **Check the index first:** Use `search_index` to find the canonical form of a person/organization name, then search articles with that exact form
- **Prefer `subject` over `keyword`** for known thematic categories: The `keyword` parameter searches title and OCR text only. The `subject` parameter searches the curated subject tags, which is more reliable for known topics.
- **Islamic publications vs. mainstream press:** `search_publications` covers Islamic community media (An-Nasr Vendredi, Islam Info, etc.), but most items are entire issues (not individual articles) with limited metadata
- **Subject field searches:** The `subject` parameter in `search_articles` matches against curated IWAC subject tags, which may use different terminology than OCR text
- **Temporal filtering:** Use `date_from` and `date_to` (YYYY-MM-DD) to target specific decades or periods
