import { INVALID_PARAMS, ProtocolError, ResourceTemplate } from "@modelcontextprotocol/server";
import { ALL_SUBSETS, config, type Subset } from "../config.js";
import { ensureView, query, queryScalarSingle, viewName } from "../db.js";
import { requestProvenance } from "../provenance.js";
import { withRequest } from "../request.js";
import type { Server } from "./_shared.js";
import { SUBSET_FIELDS, TEXT_COLS } from "./shared/fields.js";
import { bodyColumn, EMBEDDING_COLUMNS } from "./shared/research.js";
import { SENTIMENT_MODELS, sentimentCols } from "./shared/sentiment.js";

const MIME = "application/json";
const datasetResources = ALL_SUBSETS.map((subset) => ({
  name: `iwac-dataset-${subset}`, uri: `iwac://datasets/${subset}`, mimeType: MIME,
  description: `Live ${subset} schema, available fields and snapshot provenance`,
}));

/** Schema discovery stays out of the already crowded tool catalogue. */
export function registerDiscoveryResource(server: Server): void {
  server.registerResource("iwac-datasets", "iwac://datasets", {
    title: "IWAC dataset catalogue", mimeType: MIME,
    description: "Subset schemas and reproducible export guidance",
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: MIME, text: JSON.stringify({
    repository: config.datasetRepo, requested_revision: config.datasetRevision,
    subsets: datasetResources,
    exports: { tool: "explore_corpus", modes: ["manifest", "csl_json", "bibtex"], max_items_per_page: 50,
      note: "Each export identifies selected item IDs and dataset files. Compare snapshot IDs across pages; moving revisions cannot reproduce an earlier snapshot unless its source files are retained." },
  }) }] }));
  server.registerResource("iwac-dataset-schema", new ResourceTemplate("iwac://datasets/{subset}", {
    list: async () => ({ resources: datasetResources }),
    complete: { subset: async (value) => ALL_SUBSETS.filter((subset) => subset.startsWith(value)) },
  }), {
    title: "IWAC dataset schema", mimeType: MIME,
    description: "Live schema and pinned source-file identities for one subset; reading loads that subset",
    cacheHint: { ttlMs: 0, cacheScope: "private" },
  }, async (uri, variables, context) => {
    const subset = variables.subset;
    if (typeof subset !== "string" || !(ALL_SUBSETS as string[]).includes(subset))
      throw new ProtocolError(INVALID_PARAMS, "Unknown IWAC dataset subset");
    return withRequest(context.mcpReq.signal, async () => {
      const selected = subset as Subset;
      const schema = await ensureView(selected);
      const view = viewName(selected);
      const [columns, total] = await Promise.all([
        query(`DESCRIBE SELECT * FROM ${view}`), queryScalarSingle(`SELECT COUNT(*) FROM ${view}`),
      ]);
      const embedding = EMBEDDING_COLUMNS[selected];
      const payload = {
        subset: selected, total: Number(total),
        columns: columns.map((column) => ({ name: String(column.column_name), type: String(column.column_type) })),
        output_fields: SUBSET_FIELDS[selected].filter((field) =>
          (field.requires ?? [field.expr.replaceAll('"', "")]).every((required) => schema.has(required)),
        ).map((field) => ({ name: field.alias ?? field.expr.replaceAll('"', ""), views: field.views, ...(field.body ? { body: true } : {}) })),
        keyword_fields: TEXT_COLS[selected].filter((field) => schema.has(field)),
        body_field: bodyColumn(selected, schema) ?? null,
        embedding_field: embedding && schema.has(embedding) ? embedding : null,
        sentiment_models: SENTIMENT_MODELS.filter((model) => schema.has(sentimentCols(model).polarity)),
        provenance: requestProvenance("resources/read", { uri: uri.href }),
        note: "Column presence is availability, not data completeness or model quality. Country meaning depends on subset; research date filters overlap stored date precision. Citation exports omit unknown fields.",
      };
      return { contents: [{ uri: uri.href, mimeType: MIME, text: JSON.stringify(payload) }] };
    });
  });
}
