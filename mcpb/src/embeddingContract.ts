import * as fs from "node:fs";
import { z } from "zod";
import { config, type Subset } from "./config.js";

const schema = z.object({
  model: z.string().min(1),
  revision: z.string().min(1),
  dimension: z.number().int().min(1).max(8192),
  normalization: z.enum(["unit-l2", "none"]),
  dataset_revision: z.string().min(1),
  fields: z.record(z.string(), z.string().min(1)),
  query_prefix: z.string().default(""),
});
export type EmbeddingContract = z.infer<typeof schema>;
const published: EmbeddingContract = {
  model: "gemini-embedding-2",
  revision: "provider-managed",
  dimension: 768,
  normalization: "unit-l2",
  dataset_revision: "published-default",
  fields: {
    articles: "embedding_OCR",
    publications: "embedding_tableOfContents",
    references: "embedding_OCR",
    images: "embedding_image",
  },
  query_prefix: "",
};
let loaded: EmbeddingContract | undefined;
export function embeddingContract(): EmbeddingContract {
  if (loaded) return loaded;
  const file = process.env.IWAC_EMBEDDING_CONTRACT_FILE?.trim();
  const candidate = file ? schema.parse(JSON.parse(fs.readFileSync(file, "utf8"))) : published;
  if (config.embeddingProvider === "local" && (!file || !/^[a-f0-9]{40}$/i.test(candidate.dataset_revision)))
    throw new Error(
      "Local embeddings require an explicit corpus contract and immutable dataset commit; re-embed the corpus before switching models",
    );
  loaded = candidate;
  return loaded;
}
export function validateEmbeddingContract(contract: EmbeddingContract, subset: Subset, column: string): void {
  if (
    contract.model !== config.embeddingModel ||
    contract.dimension !== config.embeddingDimensionality ||
    contract.fields[subset] !== column
  ) {
    throw new Error(
      "Query model/dimension/source field does not match the corpus embedding contract. Equal dimensions do not imply compatible embedding spaces.",
    );
  }
  if (contract.dataset_revision !== "published-default" && contract.dataset_revision !== config.datasetRevision)
    throw new Error("Embedding contract dataset_revision must match IWAC_DATASET_REVISION");
}
