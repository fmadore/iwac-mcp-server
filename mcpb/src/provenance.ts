import { contractSummary } from "./embeddingContract.js";
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
    analysis_version: "iwac-research-v3",
    tool,
    arguments: args,
    datasets,
    ...(tool.startsWith("semantic_search_") ? { embedding_contract: contractSummary() } : {}),
  };
}

/** The freshness a subset reports when its files match the Hub's identities. */
const VERIFIED = "verified against Hub file identities";

/**
 * What the MODEL reads of a result's provenance, appended as the last text
 * block. The full record (file paths, SHA-256 identities, arguments,
 * timestamps) stays in `_meta` under PROVENANCE_META_KEY, where apps and
 * exports read it, and `iwac://datasets/{subset}` serves it on request.
 * Repeating it in text cost more than the answer on multi-subset calls:
 * ~2,300 characters on `search` and get_collection_stats, every call.
 * `snapshot_id` hashes those identities, so it still tells two pages of one
 * snapshot from two snapshots. Freshness appears only when a subset was not
 * verified against the Hub (offline, or a failed refresh serving its cache).
 */
export function provenanceSummary(provenance: Record<string, unknown>): Record<string, unknown> {
  const datasets = (provenance.datasets ?? {}) as Record<string, Record<string, unknown>>;
  const first = Object.values(datasets)[0];
  const unverified = Object.entries(datasets).filter(([, d]) => d.freshness !== VERIFIED);
  const model = (provenance.embedding_contract as { model?: unknown } | undefined)?.model;
  return {
    snapshot_id: provenance.snapshot_id,
    ...(first ? { revision: first.revision, access: first.access } : {}),
    subsets: Object.keys(datasets),
    ...(unverified.length ? { freshness: Object.fromEntries(unverified.map(([s, d]) => [s, d.freshness])) } : {}),
    ...(typeof model === "string" ? { embedding_model: model } : {}),
  };
}
