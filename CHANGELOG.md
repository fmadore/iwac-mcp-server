# Changelog

What each release changed, newest first. Dates are tag dates. Each release's
full notes, which are also its GitHub Release body, live in
[docs/releases/](docs/releases/); releases before v3.5.2 are described in the
Git history and on the [releases page](https://github.com/fmadore/iwac-mcp-server/releases).
[docs/decisions.md](docs/decisions.md) records the decisions in force.

## 6.3.0 (2026-11-24)

Fixes that change what a researcher gets back: `search` honours quoted phrases
and an empty quoted keyword is refused instead of selecting everything; topics on
`references` are identified by model as well as id (new exact field
`topic_model`); BibTeX keeps url and doi verbatim and CSL-JSON exports theses as
`thesis`; publication keyword pages fill their limit and full-text results carry
their url. [Notes](docs/releases/v6.3.0.md).

## 6.2.0 — 2026-11-20

Built for Claude's full-screen apps. The chart view gives Claude four tools to
work in it (read it, press its buttons, open a chart mark, load another chart),
the collection overview can be opened without a prompt and pinned to Claude's
sidebar, the charts keep a stable sandbox host over HTTP, and the semantic map
asks for full screen. [Notes](docs/releases/v6.2.0.md).

## 6.1.0 — 2026-11-18

Browser clients can reach the HTTP endpoint (CORS), which also serves an MCP
Server Card; DuckDB runs sandboxed; a call cut off during the first download
says so; the charts gain display modes, a pending state and host sizing.
[Notes](docs/releases/v6.1.0.md).

## 6.0.0 — 2026-11-02

Claude Haiku 5.5 joins the sentiment panel as its sixth model and becomes the
default reader, because it alone has read the newest arrivals (16,617 of 16,715
articles). The consensus moves to the `consensus_g2_*` columns and names its
panel fingerprint. [Notes](docs/releases/v6.0.0.md).

## 5.0.0 — 2026-10-29

One keyword rule for every search (every word must occur; quote a phrase;
`keyword_mode: "literal"` for the old match), strict inputs, coded errors,
instructions within 2,048 characters, compact provenance, linked whole-selection
exports, empty-result hints and suggestions, character-bounded pages, tool
profiles, attested releases, a digest-pinned image, Node 26 and conformance in
CI. [Notes](docs/releases/v5.0.0.md).

## 4.3.1 — 2026-10-27

SQL lambdas ready for DuckDB 2.0. [Notes](docs/releases/v4.3.1.md).

## 4.3.0

[Notes](docs/releases/v4.3.0.md).

## 4.2.0

[Notes](docs/releases/v4.2.0.md).

## 4.1.0

[Notes](docs/releases/v4.1.0.md).

## 4.0.1

[Notes](docs/releases/v4.0.1.md).

## 4.0.0

[Notes](docs/releases/v4.0.0.md).

## 3.9.0

[Notes](docs/releases/v3.9.0.md).

## 3.8.0

[Notes](docs/releases/v3.8.0.md).

## 3.7.0

[Notes](docs/releases/v3.7.0.md).

## 3.5.2

[Notes](docs/releases/v3.5.2.md).
