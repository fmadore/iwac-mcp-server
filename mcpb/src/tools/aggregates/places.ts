import { z } from "zod";
import { ensureView, q, query, queryOne, viewName } from "../../db.js";
import type { Subset } from "../../config.js";
import { CHARTS_UI_META, VIEW } from "../appUi.js";
import {
  COUNTRIES,
  errorResult,
  rowsToMap,
  structuredResult,
  toolMeta,
  validateEnum,
  type Server,
} from "../_shared.js";
import { AGG_SUBSETS, aggregateFilters, filterInputs } from "./shared.js";

const PLACES_OUTPUT = z.object({
  view: z.string(),
  subset: z.string(),
  filters: z.looseObject({}),
  total_matches: z.number(),
  items_with_place: z.number(),
  items_by_country: z.record(z.string(), z.number()).optional(),
  places: z.array(z.looseObject({})),
  ungeocoded: z.array(z.looseObject({})).optional(),
  ungeocoded_mentions: z.number().optional(),
  note: z.string().optional(),
});

export function registerPlacesTools(server: Server): void {
  // === get_place_distribution =============================================
  server.registerTool(
    "get_place_distribution",
    {
      ...toolMeta("Places on a map"),
      description:
        "Places named by a filtered set of items, joined to the index's authority records so each carries " +
        "coordinates where the index has them. Use this rather than get_field_distribution when the question is " +
        "geographic — where coverage clusters — and the plain ranking when it is not. " +
        "Only `Lieux` index entries are geocoded (555 of 683); persons, organisations and events carry no " +
        "coordinates and never will, and any named place with no index entry comes back under `ungeocoded` " +
        "rather than being dropped.",
      _meta: CHARTS_UI_META,
      inputSchema: z.object({
        subset: z.string().optional().describe("articles (default) | publications | references"),
        ...filterInputs(),
        top_n: z.number().int().optional().describe("Geocoded places returned (default 60, max 200)"),
      }),
      outputSchema: PLACES_OUTPUT,
    },
    async (args) => {
      const subsetV = validateEnum(args.subset, AGG_SUBSETS, "subset");
      if (subsetV.err) return errorResult(subsetV.err);
      const subset = (subsetV.canonical ?? "articles") as Subset;
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);

      const schema = await ensureView(subset);
      if (!schema.has("spatial")) {
        return errorResult({ error: `Subset '${subset}' has no spatial column in this dataset revision` });
      }
      const indexSchema = await ensureView("index");
      const geocoded = indexSchema.has("Coordonnées") && indexSchema.has("Titre");
      const topN = Math.max(1, Math.min(200, args.top_n ?? 60));

      const filters = aggregateFilters(subset, schema, { ...args, country: country.canonical });
      if (filters.err) return errorResult(filters.err);
      const { where, params, echo } = filters;
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const totals = await queryOne(
        `SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE NULLIF(trim(spatial), '') IS NOT NULL) AS filled
         FROM ${viewName(subset)} ${whereSql}`,
        params,
      );

      // The index stores coordinates as a "lat, lng" string, the same shape the
      // images subset uses. Split rather than trust a numeric column that does
      // not exist, and drop anything that does not parse to two finite numbers.
      const coordJoin = geocoded
        ? `LEFT JOIN (
             SELECT strip_accents(lower(trim(${q("Titre")}))) AS key,
                    TRY_CAST(trim(str_split(${q("Coordonnées")}, ',')[1]) AS DOUBLE) AS lat,
                    TRY_CAST(trim(str_split(${q("Coordonnées")}, ',')[2]) AS DOUBLE) AS lng
             FROM ${viewName("index")}
             WHERE NULLIF(trim(${q("Coordonnées")}), '') IS NOT NULL
               AND ${q("Type")} = 'Lieux'
           ) g ON g.key = v.key`
        : "";

      const rows = await query(
        `WITH v AS (
           SELECT trim(raw) AS place, strip_accents(lower(trim(raw))) AS key
           FROM (SELECT unnest(str_split(coalesce(spatial, ''), '|')) AS raw FROM ${viewName(subset)} ${whereSql})
           WHERE NULLIF(trim(raw), '') IS NOT NULL
         )
         SELECT v.place, COUNT(*) AS count${geocoded ? ", any_value(g.lat) AS lat, any_value(g.lng) AS lng" : ""}
         FROM v ${coordJoin}
         GROUP BY v.place ORDER BY count DESC, v.place`,
        params,
      );

      const places: Record<string, unknown>[] = [];
      const ungeocoded: Record<string, unknown>[] = [];
      let ungeocodedMentions = 0;
      for (const r of rows) {
        const lat = r.lat == null ? null : Number(r.lat);
        const lng = r.lng == null ? null : Number(r.lng);
        const count = Number(r.count);
        if (lat !== null && lng !== null && Number.isFinite(lat) && Number.isFinite(lng)) {
          if (places.length < topN) places.push({ place: String(r.place), count, lat, lng });
        } else {
          ungeocodedMentions += count;
          if (ungeocoded.length < 25) ungeocoded.push({ place: String(r.place), count });
        }
      }

      // Two different geographies, deliberately: where the items were PUBLISHED
      // (per-country counts) against where they LOOK (the named places). The map
      // shades the first and bubbles the second, which is the comparison worth
      // drawing — a press that covers itself reads very differently from one
      // that covers elsewhere.
      const byCountry = schema.has("country")
        ? rowsToMap(
            await query(
              `SELECT trim(raw) AS k, COUNT(*) AS c
               FROM (SELECT unnest(str_split(coalesce(country, ''), '|')) AS raw FROM ${viewName(subset)} ${whereSql})
               WHERE NULLIF(trim(raw), '') IS NOT NULL GROUP BY 1`,
              params,
            ),
          )
        : {};

      return structuredResult({
        view: VIEW.places,
        subset,
        filters: echo,
        total_matches: Number(totals?.n ?? 0),
        items_with_place: Number(totals?.filled ?? 0),
        ...(Object.keys(byCountry).length ? { items_by_country: byCountry } : {}),
        places,
        ...(ungeocoded.length ? { ungeocoded, ungeocoded_mentions: ungeocodedMentions } : {}),
        note:
          `Coordinates come from the index's 'Lieux' authority records, which cover 555 of 683 places; a named ` +
          `place with no geocoded index entry is listed under 'ungeocoded' with its count, not dropped. ` +
          `'spatial' is multi-valued, so counts sum to more than the item count.`,
      });
    },
  );

}
