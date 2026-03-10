# TODO

## Data Enrichment

- [ ] **Populate the `subject` column for the references subset**
  The `subject` field is mostly empty for references, making them hard to discover via subject-based searches. Enrich reference records with subject tags (e.g., "Hadj", "pèlerinage", "éducation islamique") to improve findability. This would allow `search_references` to eventually support a `subject` parameter like `search_articles` does.

## Skill Improvements

- [ ] **Enrich `research-domains.md` with actual IWAC frequency data**
  Use the HuggingFace index subset and `list_subjects` (200 subjects available) to replace manually curated search terms with data-grounded suggestions including actual frequencies. Also pull top persons (`list_persons`) and locations (`list_locations`) to add prominent actors and places per research domain.

- [x] ~~**Fix skill docs: references can be in English, not just French**~~ (done)

- [ ] **Improve `search_references` search guidance in skill docs**
  Document that the `keyword` parameter searches title and abstract as a single substring match. Searching "pelerinage Mecque" (combined) will miss results that only have one of those words. Always search one term at a time with separate calls.

- [ ] How to deal with Islamic publications, with limited metadata, and very long text: Table of contents

## MCP Server Features

- [ ] **Add search by AI-generated abstract for articles**
  Articles have AI-generated abstracts in the dataset. Add support for searching these abstracts via `search_articles` (new `abstract` keyword search field or include abstracts in the existing keyword search). This would improve discoverability since abstracts are more structured than raw OCR text.