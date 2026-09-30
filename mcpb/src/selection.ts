/** Dependency-free research selection shared by the server and its app. */
export interface Selection {
  keyword?: string;
  keyword_mode?: "literal" | "all_terms";
  keyword_aliases?: string[];
  country?: string;
  newspaper?: string;
  subject?: string;
  date_from?: string;
  date_to?: string;
  /** AND across fields AND across each field's values. Never silently widen. */
  exact?: Record<string, string[]>;
  hijri_month?: string;
  hijri_year?: number;
}

export const EXACT_FIELDS = [
  "subject",
  "spatial",
  "author",
  "language",
  "country",
  "newspaper",
  "topic_id",
  "min_prob",
  "scored_by",
] as const;

export function selectionFrom(value: Record<string, unknown> = {}): Selection {
  const out: Record<string, unknown> = {};
  for (const key of [
    "keyword",
    "keyword_mode",
    "keyword_aliases",
    "country",
    "newspaper",
    "subject",
    "date_from",
    "date_to",
    "exact",
    "hijri_month",
    "hijri_year",
  ]) {
    const v = value[key];
    if (v !== undefined && v !== null && v !== "") out[key] = v;
  }
  // Older topic payloads carried this at the top level.
  if (typeof value.min_prob === "number") {
    out.exact = { ...(out.exact as Selection["exact"]), min_prob: [String(value.min_prob)] };
  }
  return out as Selection;
}

export function narrowSelection(selection: Selection, field: string, value: string): Selection {
  const existing = selection.exact?.[field] ?? [];
  return { ...selection, exact: { ...selection.exact, [field]: [...new Set([...existing, value])] } };
}
