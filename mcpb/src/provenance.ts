import { embeddingContract } from "./embeddingContract.js";
import { createHash } from "node:crypto";
import { requestSnapshots } from "./request.js";
export const PROVENANCE_META_KEY = "islam.zmo.de/provenance";
export function requestProvenance(tool: string, args: unknown): Record<string, unknown> {
  const datasets = Object.fromEntries(
    [...(requestSnapshots() ?? [])].sort(([a], [b]) => a.localeCompare(b)).map(([subset, s]) => [subset, s.provenance]),
  );
  const identities = Object.fromEntries(
    Object.entries(datasets).map(([subset, p]) => [
      subset,
      { repository: p.repository, revision: p.revision, files: p.files },
    ]),
  );
  return {
    snapshot_id: createHash("sha256").update(JSON.stringify(identities)).digest("hex"),
    analysis_version: "iwac-research-v1",
    tool,
    arguments: args,
    datasets,
    ...(tool.startsWith("semantic_search_") ? { embedding_contract: embeddingContract() } : {}),
  };
}
