import type { Subset } from "../../config.js";
import { SUBSET_FIELDS } from "./fields.js";

/** Column descriptor is the authority for what counts as an item's body. */
export function bodyColumn(subset: Subset, schema: Set<string>): string | undefined {
  const descriptor = SUBSET_FIELDS[subset].find((f) => f.body);
  const col = descriptor?.requires?.[0] ?? descriptor?.expr.replaceAll('"', "");
  return col && schema.has(col) ? col : undefined;
}

export const EMBEDDING_COLUMNS: Partial<Record<Subset, string>> = {
  articles: "embedding_OCR",
  references: "embedding_OCR",
  publications: "embedding_tableOfContents",
  images: "embedding_image",
};
