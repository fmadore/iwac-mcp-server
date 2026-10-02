import type { Subset } from "../config.js";
import { q, type Row } from "../db.js";
import { requestProvenance } from "../provenance.js";
import { TITLE_COL } from "./shared/fields.js";
import { validateDateBounds } from "./shared/filters.js";

export const EXPORT_MODES = ["manifest", "csl_json", "bibtex"] as const;
export type ExportMode = (typeof EXPORT_MODES)[number];
export const isExportMode = (mode: string): mode is ExportMode => (EXPORT_MODES as readonly string[]).includes(mode);

/** Select citation metadata only. Body, model annotations and vectors never enter an export. */
export function citationProjection(subset: Subset, schema: Set<string>): string {
  const fields = new Map([
    ["o:id", "id"], ["iwac_url", "url"], [TITLE_COL[subset], "title"], ["pub_date", "date"],
    ...["author", "creator", "editor", "newspaper", "publisher", "book_title", "is_part_of", "type", "doi",
      "volume", "issue", "page_start", "page_end", "edition", "language"].map((field): [string, string] => [field, field]),
  ]);
  return [...fields].filter(([field]) => schema.has(field)).map(([field, alias]) => `${q(field)} AS ${q(alias)}`).join(", ");
}

const value = (row: Row, field: string): string | undefined => {
  const stored = row[field];
  return stored === undefined || stored === null || !String(stored).trim() ? undefined : String(stored).trim();
};
const people = (stored: string | undefined) => stored?.split("|").map((part) => part.trim()).filter(Boolean).map((literal) => ({ literal }));

/** Preserve date precision; omit ranges/malformed dates instead of guessing. */
function issued(stored: string | undefined): { "date-parts": number[][] } | undefined {
  if (!stored || !/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(stored) || validateDateBounds(stored).err) return undefined;
  return { "date-parts": [stored.split("-").map(Number)] };
}

function citationType(subset: Subset, row: Row): string {
  if (subset === "articles") return "article-newspaper";
  if (subset === "images") return "graphic";
  const known: Record<string, string> = {
    "Article de revue": "article-journal", Livre: "book", "Chapitre de livre": "chapter", Rapport: "report",
    "Thèse": "thesis", "Mémoire": "thesis",
  };
  return known[value(row, "type") ?? ""] ?? "document";
}

export function citationItem(subset: Subset, row: Row): Row {
  const item: Row = { id: String(row.id), type: citationType(subset, row), URL: value(row, "url") };
  const fields: Record<string, unknown> = {
    title: value(row, "title"), author: people(value(row, "author") ?? value(row, "creator")),
    editor: people(value(row, "editor")), issued: issued(value(row, "date")),
    "container-title": value(row, "newspaper") ?? value(row, "book_title") ?? value(row, "is_part_of"),
    publisher: value(row, "publisher"), DOI: value(row, "doi"), volume: value(row, "volume"),
    issue: value(row, "issue"), edition: value(row, "edition"), language: value(row, "language"),
    page: [value(row, "page_start"), value(row, "page_end")].filter(Boolean).join("–") || undefined,
  };
  for (const [key, field] of Object.entries(fields)) if (field !== undefined) item[key] = field;
  // Keep a non-machine-readable date as supplied, without synthesizing a year.
  if (value(row, "date") && !fields.issued) item.note = `Stored date: ${value(row, "date")}`;
  return item;
}

/** Escape syntax per character so replacements never re-escape one another. */
function bibEscape(text: string): string {
  const escapes: Record<string, string> = {
    "\\": "\\textbackslash{}", "{": "\\{", "}": "\\}", "%": "\\%", "&": "\\&", "#": "\\#",
    _: "\\_", $: "\\$", "~": "\\textasciitilde{}", "^": "\\textasciicircum{}",
  };
  return [...text.replace(/[\r\n]+/g, " ")].map((char) => escapes[char] ?? char).join("");
}

export function bibliography(items: Row[]): string {
  return items.map((item) => {
    const types: Record<string, string> = { book: "book", chapter: "incollection", "article-journal": "article", "article-newspaper": "article", report: "techreport" };
    const fields: [string, string][] = [];
    const names = (key: string) => (item[key] as { literal: string }[] | undefined)?.map(({ literal }) => `{${bibEscape(literal)}}`).join(" and ");
    for (const key of ["author", "editor"]) {
      const encoded = names(key);
      if (encoded) fields.push([key, encoded]);
    }
    const mapping = { title: "title", publisher: "publisher", DOI: "doi", URL: "url", volume: "volume", issue: "number", page: "pages", edition: "edition", note: "note" };
    for (const [key, target] of Object.entries(mapping)) if (item[key]) fields.push([target, bibEscape(String(item[key]))]);
    if (item["container-title"]) fields.push([item.type === "chapter" ? "booktitle" : "journal", bibEscape(String(item["container-title"]))]);
    const date = (item.issued as { "date-parts": number[][] } | undefined)?.["date-parts"][0];
    if (date) {
      fields.push(["year", String(date[0])]);
      // `date` also preserves month/day for biblatex-aware consumers.
      fields.push(["date", date.map((part, index) => String(part).padStart(index ? 2 : 4, "0")).join("-")]);
    }
    const key = `iwac-${String(item.id).replace(/[^a-zA-Z0-9:-]/g, "-")}`;
    return `@${types[String(item.type)] ?? "misc"}{${key},\n${fields.map(([field, text]) => `  ${field} = {${text}}`).join(",\n")}\n}`;
  }).join("\n\n");
}

export function researchExport(
  mode: ExportMode,
  subset: Subset,
  rows: Row[],
  filters: Record<string, unknown>,
  pagination: { offset: number; limit: number; total_matches: number },
) {
  const manifest = {
    export_version: "iwac-corpus-v1", subset, selection: filters,
    ...pagination, returned: rows.length, has_more: pagination.offset + rows.length < pagination.total_matches,
    order: "pub_date descending NULLS LAST when available, then item ID",
    records: rows.map(({ id, url, title, date }) => ({ id, url, ...(title ? { title } : {}), ...(date ? { date } : {}) })),
    provenance: requestProvenance("explore_corpus", { mode, subset, selection: filters, offset: pagination.offset, limit: pagination.limit }),
    note: "This manifest identifies this page only. Compare snapshot_id across pages; restart the export if it changes. Citation fields are stored metadata, not verified bibliographic corrections. Names remain literal.",
  };
  const citations = rows.map((row) => citationItem(subset, row));
  const content = mode === "bibtex" ? bibliography(citations) : JSON.stringify(mode === "csl_json" ? citations : manifest, null, 2);
  return {
    format: mode,
    mime_type: mode === "bibtex" ? "application/x-bibtex" : mode === "csl_json" ? "application/vnd.citationstyles.csl+json" : "application/json",
    filename: `iwac-${subset}-${pagination.offset}-${mode}.${mode === "bibtex" ? "bib" : "json"}`,
    content,
    ...(mode !== "manifest" ? { manifest } : {}),
  };
}
