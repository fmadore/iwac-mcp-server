import type { ChartPayload } from "../../viewContract.js";
import { chartResult } from "../shared/chartResults.js";
import { z } from "zod";
import { ensureView, q, query, queryScalarSingle, viewName } from "../../db.js";
import { CHARTS_UI_META, VIEW } from "../appUi.js";
import {
  COUNTRIES,
  errorResult,
  toolMeta,
  validateEnum,
  type Server,
} from "../_shared.js";
import { aggregateFilters, filterInputs } from "./shared.js";

const GROUP_FIELDS = ["year", "newspaper", "country"] as const;

const LEXICAL_OUTPUT = z.object({
  view: z.string(),
  group_by: z.string(),
  filters: z.looseObject({}),
  total_matches: z.number(),
  groups: z.array(z.looseObject({})),
  metrics: z.record(z.string(), z.looseObject({})),
  readability_excluded: z.number().optional(),
  note: z.string().optional(),
});

export function registerLexicalTools(server: Server): void {
  // === get_lexical_metrics ================================================
  server.registerTool(
    "get_lexical_metrics",
    {
      ...toolMeta("Press language metrics"),
      description:
        "Readability, lexical richness and length of the press text, averaged by year, newspaper or country. " +
        "`Lisibilite_OCR` is a French readability score (higher = easier); `Richesse_Lexicale_OCR` is MATTR, a " +
        "moving-average type-token ratio that is ALREADY length-robust — do not normalise it by word count or " +
        "bin it by length. Readability is computed against a French lexicon, so non-French items are excluded " +
        "from that metric (and counted in readability_excluded) rather than reported as unreadable; MATTR and " +
        "word count need no lexicon and cover everything. Only items whose full text ships in this public " +
        "dataset carry these columns at all.",
      _meta: CHARTS_UI_META,
      inputSchema: z.object({
        group_by: z.string().optional().describe("year (default) | newspaper | country"),
        ...filterInputs(),
        top_n: z.number().int().optional().describe("Groups returned when grouping by newspaper (default 20, max 60)"),
      }),
      outputSchema: LEXICAL_OUTPUT,
    },
    async (args) => {
      const groupV = validateEnum(args.group_by, GROUP_FIELDS, "group_by");
      if (groupV.err) return errorResult(groupV.err);
      const groupBy = groupV.canonical ?? "year";
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);

      const schema = await ensureView("articles");
      const METRICS: [string, string][] = [
        ["Lisibilite_OCR", "readability"],
        ["Richesse_Lexicale_OCR", "mattr"],
        ["nb_mots", "words"],
      ];
      const present = METRICS.filter(([col]) => schema.has(col));
      if (!present.length) {
        return errorResult({ error: "This dataset revision carries no lexical metric columns" });
      }
      if (groupBy !== "year" && !schema.has(groupBy)) {
        return errorResult({
          error: `group_by '${groupBy}' is not available`,
          valid_values: GROUP_FIELDS.filter((g) => g === "year" || schema.has(g)),
        });
      }
      const topN = Math.max(1, Math.min(60, args.top_n ?? 20));

      const filters = aggregateFilters("articles", schema, { ...args, country: country.canonical });
      if (filters.err) return errorResult(filters.err);
      const { where, params, echo } = filters;
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const groupExpr =
        groupBy === "year" ? `NULLIF(substr(CAST(pub_date AS VARCHAR), 1, 4), '')` : `NULLIF(trim(${q(groupBy)}), '')`;

      // Readability is French-lexicon based, so a Dendi or English item scores
      // as "hard" for reasons that have nothing to do with its prose. Excluding
      // it from THAT metric only is the honest fix: MATTR is a type-token ratio
      // and needs no lexicon, so it stays valid for every language.
      const frenchOnly = schema.has("language")
        ? `CASE WHEN coalesce(NULLIF(trim(language), ''), 'Français') ILIKE '%français%' THEN "Lisibilite_OCR" END`
        : `"Lisibilite_OCR"`;

      const selects = present
        .map(([col, name]) =>
          name === "readability"
            ? `ROUND(AVG(${frenchOnly}), 2) AS ${name}_avg, ROUND(median(${frenchOnly}), 2) AS ${name}_median, ` +
              `COUNT(${frenchOnly}) AS ${name}_n`
            : `ROUND(AVG(${q(col)}), ${name === "words" ? 0 : 3}) AS ${name}_avg, ` +
              `ROUND(median(${q(col)}), ${name === "words" ? 0 : 3}) AS ${name}_median, ` +
              `COUNT(${q(col)}) AS ${name}_n`,
        )
        .join(", ");

      const order = groupBy === "year" ? "ORDER BY grp" : `ORDER BY items DESC LIMIT ${topN}`;
      const rows = await query(
        `SELECT ${groupExpr} AS grp, COUNT(*) AS items, ${selects}
         FROM ${viewName("articles")} ${whereSql}
         GROUP BY 1 HAVING ${groupExpr} IS NOT NULL ${order}`,
        params,
      );
      const total = Number(
        (await queryScalarSingle<number | bigint>(
          `SELECT COUNT(*) FROM ${viewName("articles")} ${whereSql}`,
          params,
        )) ?? 0,
      );
      const excluded = schema.has("language")
        ? Number(
            (await queryScalarSingle<number | bigint>(
              `SELECT COUNT(*) FROM ${viewName("articles")} ${whereSql}${whereSql ? " AND" : " WHERE"} ` +
                `"Lisibilite_OCR" IS NOT NULL AND NULLIF(trim(language), '') IS NOT NULL ` +
                `AND language NOT ILIKE '%français%'`,
              params,
            )) ?? 0,
          )
        : 0;

      const payload: ChartPayload<"lexical"> & Record<string, unknown> = {
        view: VIEW.lexical,
        group_by: groupBy,
        filters: echo,
        total_matches: total,
        groups: rows.map((r) => {
          const rec: Record<string, unknown> = { group: String(r.grp), items: Number(r.items) };
          for (const [, name] of present) {
            if (r[`${name}_avg`] != null) rec[`${name}_avg`] = Number(r[`${name}_avg`]);
            if (r[`${name}_median`] != null) rec[`${name}_median`] = Number(r[`${name}_median`]);
            rec[`${name}_n`] = Number(r[`${name}_n`] ?? 0);
          }
          return rec;
        }),
        metrics: {
          ...(present.some(([, n]) => n === "readability")
            ? { readability: { label: "Readability (French)", higher_is: "easier", range: "0-100" } }
            : {}),
          ...(present.some(([, n]) => n === "mattr")
            ? { mattr: { label: "Lexical richness (MATTR)", higher_is: "more varied", range: "0-1" } }
            : {}),
          ...(present.some(([, n]) => n === "words") ? { words: { label: "Words per item", higher_is: "longer" } } : {}),
        },
      };
      if (excluded) payload.readability_excluded = excluded;
      if (groupBy === "newspaper" && rows.length >= topN) {
        payload.note = `Showing the ${topN} newspapers with the most matching items.`;
      }
      return chartResult(payload);
    },
  );}
