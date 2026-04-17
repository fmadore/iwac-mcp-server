# TODO

## Distribution & Roadmap

- [ ] **Submit to the Anthropic extension directory**
  Fill out the interest form:
  <https://docs.google.com/forms/d/e/1FAIpQLScHtjkiCNjpqnWtFLIQStChXlvVcvX8NPXkMfjtYPDPymgang/viewform>
  Prereqs: public GitHub repo ✓, MIT licence ✓, Node.js ✓, valid `manifest.json`
  with `author` pointing at the GitHub profile ✓.
  See also Anthropic's Software Directory Policy:
  <https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy>

- [ ] **Code-sign the `.mcpb`** with a trusted code-signing cert
  (DigiCert / SSL.com, ~$100/yr) so Claude Desktop stops showing the generic
  "grants access to everything" warning. Self-signed certs don't help — Claude
  Desktop only trusts real CAs. Command:
  `mcpb sign iwac-mcp-server.mcpb --cert prod.pem --key prod.key`

- [ ] **Replace Gemini semantic search with a free local model** so the two
  `semantic_search_*` tools work offline without any API key. Candidates:
  `intfloat/multilingual-e5-small` or
  `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` via
  `@xenova/transformers` (ONNX Runtime). Requires regenerating embedding
  columns in the HF dataset (add alongside the existing `embedding_OCR` /
  `embedding_tableOfContents` to preserve compatibility).

- [ ] **Add an icon** (`icon.png`, 256×256 PNG) to the bundle so the extension
  has a visual identity in the install dialog and directory listing.

- [ ] **Add `screenshots/`** showing a research query in Claude Desktop — the
  directory listing surfaces these.

## Data Enrichment

- [ ] **Populate the `subject` column for the references subset**
  The `subject` field is mostly empty for references, making them hard to
  discover via subject-based searches. Enrich reference records with subject
  tags (e.g. "Hadj", "pèlerinage", "éducation islamique"). Would let
  `search_references` support a `subject` parameter like `search_articles`.

## Skill Improvements

- [ ] **Enrich `research-domains.md` with actual IWAC frequency data**
  Use `list_subjects` (200 subjects), `list_persons`, and `list_locations` to
  replace manually curated search terms with data-grounded suggestions
  including actual frequencies.

- [x] ~~**Fix skill docs: references can be in English, not just French**~~

- [ ] **Improve `search_references` guidance** in skill docs. Document that
  `keyword` does a single substring match on title+abstract, so combined terms
  like "pelerinage Mecque" miss results with only one of the words. Call each
  term separately.

- [ ] How to deal with Islamic publications (limited metadata, very long OCR,
  rely on tables of contents).

## MCP Server Features

- [ ] **Add search by AI-generated abstract for articles**
  Articles have AI-generated abstracts (`descriptionAI`) in the dataset. Let
  `search_articles` match against it (either as a new field or folded into the
  existing keyword search). Abstracts are more structured than raw OCR and
  would improve precision.

- [ ] **Publish the `iwac-mcp` research skill** separately (Claude Skills
  repository or as part of the bundle once skill packaging is supported).
  Currently lives under `.claude/skills/iwac-mcp/`.
