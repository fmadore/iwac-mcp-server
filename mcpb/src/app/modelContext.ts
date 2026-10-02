import { EXACT_FIELDS } from "../selection.js";
import type { BasePayload, ViewOptions, ViewResult } from "./shell.js";

type ObjectValue = Record<string, unknown>;
type Primitive = string | number | boolean | null;
const encoder = new TextEncoder();
const bytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const SUBSETS = new Set(["articles", "publications", "documents", "audiovisual", "images", "index", "references"]);
const FILTER_KEYS = ["keyword", "keyword_mode", "country", "newspaper", "subject", "date_from", "date_to", "hijri_month", "hijri_year", "country_filter", "newspaper_filter", "language", "author", "type", "min_prob", "topic_id"];
const COUNT_KEYS = ["total_matches", "total_articles", "total_records", "count", "dated_count", "undated_count", "invalid_date_count", "imprecise_date_count", "projected", "offset", "limit", "overlap", "omitted_cells"];

/** Small, whitelisted display state for updateModelContext. Never copy result
 * bodies, export content, distribution arrays, vectors or point coordinates. */
export function buildModelContext(payload: BasePayload, options: ViewOptions, result: ViewResult): {
  content: [{ type: "text"; text: string }];
  structuredContent: Record<string, unknown>;
} {
  const omitted = new Set<string>();
  const mark = (path: string): void => { omitted.add(path.length > 128 ? `${path.slice(0, 125)}...` : path); };
  const clip = (value: string, maximum: number, path: string): string => {
    let used = 0;
    let end = 0;
    for (const char of value) {
      const n = encoder.encode(char).length;
      if (used + n > maximum - 3) {
        mark(path);
        return `${value.slice(0, end)}…`;
      }
      used += n;
      end += char.length;
    }
    return value;
  };
  const primitive = (value: unknown, path: string, length = 160): Primitive | undefined => {
    if (typeof value === "string") return clip(value, length, path);
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
    if (typeof value === "boolean" || value === null) return value;
    return undefined;
  };
  const pick = (input: unknown, keys: string[], path: string, length = 160): ObjectValue => {
    const source = object(input);
    const out: ObjectValue = {};
    for (const key of keys) {
      const value = primitive(source[key], `${path}.${key}`, length);
      if (value !== undefined && value !== null && value !== "") out[key] = value;
      else if (value === undefined && source[key] !== undefined) mark(`${path}.${key}`);
    }
    return out;
  };
  const strings = (input: unknown, path: string, count: number, length: number): string[] => {
    if (!Array.isArray(input)) { if (input !== undefined && input !== null) mark(path); return []; }
    if (input.length > count) mark(path);
    const page = input.slice(0, count);
    if (page.some((value) => typeof value !== "string")) mark(path);
    return page.filter((value): value is string => typeof value === "string")
      .map((value) => clip(value, length, path));
  };
  const selection = (input: unknown, path: string): ObjectValue => {
    const source = object(input);
    let checked = 0;
    for (const key in source) {
      if (!Object.hasOwn(source, key)) continue;
      if (++checked > 64) { mark(path); break; }
      if (![...FILTER_KEYS, "exact", "keyword_aliases"].includes(key)) mark(`${path}.unsupported_field`);
    }
    const selected = pick(source, FILTER_KEYS, path);
    const aliases = strings(source.keyword_aliases, `${path}.keyword_aliases`, 12, 96);
    if (aliases.length) selected.keyword_aliases = aliases;
    const exact: ObjectValue = {};
    if (source.exact !== undefined && (source.exact === null || typeof source.exact !== "object" || Array.isArray(source.exact))) mark(`${path}.exact`);
    const fields: [string, unknown][] = [];
    const rawExact = object(source.exact);
    let inspected = 0;
    for (const field in rawExact) {
      if (!Object.hasOwn(rawExact, field)) continue;
      if (++inspected > 64) { mark(`${path}.exact`); break; }
      if ((EXACT_FIELDS as readonly string[]).includes(field) || (field.length <= 96 && /^(polarity|centrality|subjectivity):[a-z0-9_-]+$/.test(field)))
        fields.push([field, rawExact[field]]);
      else mark(`${path}.unsupported_exact_field`);
    }
    if (fields.length > 12) mark(`${path}.exact`);
    for (const [field, values] of fields.slice(0, 12)) {
      const list = strings(values, `${path}.exact.${field}`, 8, 96);
      if (list.length) exact[clip(field, 96, `${path}.exact`)] = list;
    }
    if (Object.keys(exact).length) selected.exact = exact;
    // A truncated predicate must be clearly labelled, never mistaken for the
    // complete reproducible tool selection. Keep the original tool response.
    while (bytes(selected) > 2_000) {
      if (Object.keys(exact).length) {
        const key = Object.keys(exact).at(-1) as string;
        delete exact[key];
        mark(`${path}.exact`);
        if (!Object.keys(exact).length) delete selected.exact;
      } else {
        const key = Object.keys(selected).at(-1) as string;
        delete selected[key];
        mark(`${path}.${key}`);
      }
    }
    return selected;
  };

  const summary: ObjectValue = {
    context_version: "iwac-app-v1",
    ...pick(payload, ["view", "subset", "mode", "field", "calendar", "granularity", "group_by", "normalize_by", "color_by", "has_more"], "view", 96),
    title: clip(result.title, 240, "title"),
  };
  if (result.subtitle) summary.subtitle = clip(result.subtitle, 320, "subtitle");
  const add = (key: string, value: unknown): void => {
    if (bytes({ ...summary, [key]: value }) <= 9_000) summary[key] = value;
    else mark(key);
  };

  const provenance = object(payload.provenance);
  const dataset = pick(provenance, ["snapshot_id", "analysis_version"], "dataset", 96);
  const datasets: ObjectValue = {};
  for (const subset of SUBSETS) {
    const source = object(provenance.datasets)[subset];
    if (!source) continue;
    datasets[subset] = pick(source, ["repository", "revision"], `dataset.${subset}`, 120);
  }
  if (Object.keys(dataset).length) add("dataset", dataset);

  const comparisons = Array.isArray(payload.selections) ? payload.selections : [];
  if (comparisons.length) {
    if (comparisons.length > 2) mark("comparison_selections");
    add("comparison_selections", comparisons.slice(0, 2).map((value, index) => {
      const source = object(value);
      return {
        ...pick(source, ["label", "total", "fulltext", "embedded", "scored"], `comparison.${index}`, 32),
        filters: selection(source.filters, `comparison.${index}.filters`),
      };
    }));
  } else add("selection", selection(payload.filters ?? result.chips, "selection"));

  if (Object.keys(datasets).length) add("dataset", { ...dataset, datasets });

  const display = pick(options, ["layout", "timeline", "metric", "percent"], "display", 32);
  if (Object.keys(display).length) add("display", display);
  const counts = pick(payload, COUNT_KEYS, "counts", 32);
  if (Object.keys(counts).length) add("counts", counts);
  if (payload.view === "sentiment") {
    const sentiment = pick(payload, ["model"], "sentiment", 96);
    const pair = pick(payload.agreement_matrix, ["rows", "cols", "field", "common_scored", "excluded_articles", "agreement_percent", "kappa", "weighted_kappa"], "sentiment.pair", 96);
    if (Object.keys(pair).length) sentiment.pair = pair;
    add("sentiment", sentiment);
  }

  if ((result.notes?.length ?? 0) > 5) mark("notes");
  const notes = strings([payload.note, ...(result.notes?.slice(0, 5) ?? [])].filter((note): note is string => typeof note === "string" && !!note), "notes", 5, 360);
  if (notes.length) add("notes", [...new Set(notes)]);
  const ids = new Set<string>();
  const prefix = typeof payload.subset === "string" && SUBSETS.has(payload.subset) ? payload.subset
    : ["similar", "semanticMap"].includes(payload.view ?? "") ? "articles" : undefined;
  const addId = (raw: unknown): void => {
    const id = typeof raw === "string" || typeof raw === "number" ? String(raw) : "";
    if (/^(articles|publications|documents|audiovisual|images|index|references):\d{1,20}$/.test(id)) ids.add(id);
    else if (prefix && /^\d{1,20}$/.test(id)) ids.add(`${prefix}:${id}`);
  };
  addId(payload.id);
  addId(object(payload.source).id);
  const sourceRows = payload.view === "semanticMap" ? payload.points
    : payload.view === "similar" ? payload.neighbours
      : ["records", "aliases"].includes(payload.view ?? "") ? payload.rows : undefined;
  if (Array.isArray(sourceRows)) {
    if (sourceRows.length > 40) mark("source_ids");
    for (const row of sourceRows.slice(0, 40)) {
      if (ids.size >= 20) { mark("source_ids"); break; }
      addId(object(row).id);
    }
    add("source_rows_in_view", sourceRows.length);
  }
  if (ids.size) add("source_ids", [...ids]);
  summary.truncated = omitted.size > 0;
  if (omitted.size) {
    summary.truncated_fields = [...omitted].slice(0, 12);
    summary.truncation_note = "This display summary is abbreviated. Read the original tool result for complete filters, sources and caveats; do not reproduce a selection from truncated filters.";
  }
  // The short readable block does not repeat structured filters or source
  // lists. A 600-byte ceiling leaves ample room under 12 kB for both channels.
  const readable = [
    `Current IWAC view: ${summary.title}`,
    ...(summary.subtitle ? [String(summary.subtitle)] : []),
    ...notes.slice(0, 1),
    ...(summary.truncated ? ["Display context abbreviated; full selection remains in the tool result."] : []),
  ].join("\n");
  let text = clip(readable, 600, "readable_summary");
  if (omitted.size && summary.truncated !== true) {
    summary.truncated = true;
    summary.truncated_fields = [...omitted].slice(0, 12);
    summary.truncation_note = "Readable summary abbreviated; structured selection remains available.";
  }
  const output = (): { content: [{ type: "text"; text: string }]; structuredContent: Record<string, unknown> } => ({ content: [{ type: "text", text }], structuredContent: summary });
  // Text-only hosts stringify structuredContent into the text block, causing
  // a second layer of JSON escaping. Bound that case too, leaving 1 kB of the
  // 12 kB budget for a user-triggered question prefix added by the caller.
  const textOnly = () => ({ content: [{ type: "text", text: `${text}\n${JSON.stringify(summary)}` }] });
  let reductions = 0;
  while (bytes(output()) > 11_000 || bytes(textOnly()) > 11_000) {
    if (++reductions > 32) {
      const labels = Array.isArray(summary.comparison_selections)
        ? summary.comparison_selections.map((entry) => ({ ...pick(entry, ["label", "total"], "comparison", 32), filters: {} })) : undefined;
      const snapshot = object(summary.dataset).snapshot_id;
      for (const key of Object.keys(summary)) delete summary[key];
      Object.assign(summary, {
        context_version: "iwac-app-v1", title: "IWAC display", truncated: true,
        truncation_note: "Context exceeded its transport limit; read the original tool result for the complete selection.",
        ...(labels ? { comparison_selections: labels } : {}),
        ...(typeof snapshot === "string" && /^[a-f0-9]{64}$/i.test(snapshot) ? { dataset: { snapshot_id: snapshot } } : {}),
      });
      text = "IWAC display context abbreviated; read the original tool result.";
      break;
    }
    summary.truncated = true;
    summary.truncation_note = "Display context abbreviated. Read the original tool result for complete filters, sources and caveats.";
    if (text.length > 100) { text = `${text.slice(0, Math.floor(text.length / 2))}…`; mark("readable_summary"); }
    else if (summary.notes) { delete summary.notes; mark("notes"); }
    else if (summary.source_ids) { delete summary.source_ids; mark("source_ids"); }
    else if (object(summary.dataset).datasets) { delete object(summary.dataset).datasets; mark("dataset.repositories"); }
    else if (summary.subtitle) { delete summary.subtitle; mark("subtitle"); }
    else if (summary.counts) { delete summary.counts; mark("counts"); }
    else if (summary.display) { delete summary.display; mark("display"); }
    else {
      // Comparison envelopes/labels survive even when an unusually verbose
      // predicate must be abbreviated to meet the transport limit.
      const filters = Array.isArray(summary.comparison_selections)
        ? summary.comparison_selections.map((value) => object(object(value).filters))
        : [object(summary.selection)];
      const largest = filters.sort((a, b) => bytes(b) - bytes(a))[0];
      const key = Object.keys(largest ?? {}).at(-1);
      if (key) { delete largest[key]; mark("selection.filters"); }
      else { summary.title = "IWAC display"; delete summary.truncated_fields; }
    }
    summary.truncated_fields = [...omitted].slice(0, 12);
  }
  return output();
}
