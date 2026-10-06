import { chartResult } from "../shared/chartResults.js";
import { z } from "zod";
import { ensureView, q, query, queryOne, viewName, viewGeneration } from "../../db.js";
import type { Subset } from "../../config.js";
import { CHARTS_UI_META, VIEW } from "../appUi.js";
import { COUNTRIES, errorResult, rowsToMap, toolMeta, validateEnum, type Server } from "../_shared.js";
import { AGG_SUBSETS, aggregateFilters, explode, filterInputs, withScope } from "./shared.js";

const geoCache = new Map<number, { total: number; geocoded: number }>();

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
  geocode_coverage: z.object({ total: z.number(), geocoded: z.number() }).optional(),
  note: z.string().optional(),
});

export function registerPlacesTools(server: Server): void {
  // === get_place_distribution =============================================
  server.registerTool(
    "get_place_distribution",
    {
      ...toolMeta("Places on a map"),
      description:
        "Place tags joined to authority coordinates. Separates publication countries from mentioned places; missing geocodes are counted explicitly.",
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
      const subset: Subset = subsetV.canonical ?? "articles";
      const country = validateEnum(args.country, COUNTRIES, "country");
      if (country.err) return errorResult(country.err);

      const schema = await ensureView(subset);
      if (!schema.has("spatial")) {
        return errorResult({ error: `Subset '${subset}' has no spatial column in this dataset revision` });
      }
      const indexSchema = await ensureView("index");
      const geocoded = indexSchema.has("Coordonnées") && indexSchema.has("Titre") && indexSchema.has("Type");
      const generation = viewGeneration("index");
      let geoCoverage = geoCache.get(generation);
      if (!geoCoverage && geocoded) {
        const counts = await queryOne(
          `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE TRY_CAST(trim(str_split(${q("Coordonnées")}, ',')[1]) AS DOUBLE) BETWEEN -90 AND 90 AND TRY_CAST(trim(str_split(${q("Coordonnées")}, ',')[2]) AS DOUBLE) BETWEEN -180 AND 180) AS geocoded FROM ${viewName("index")} WHERE ${q("Type")} = 'Lieux'`,
        );
        geoCoverage = { total: Number(counts?.total ?? 0), geocoded: Number(counts?.geocoded ?? 0) };
        if (geoCache.size > 2) geoCache.clear();
        geoCache.set(generation, geoCoverage);
      }
      const topN = Math.max(1, Math.min(200, args.top_n ?? 60));

      const filters = aggregateFilters(subset, schema, { ...args, country: country.canonical });
      if (filters.err) return errorResult(filters.err);
      const { echo } = filters;
      return withScope(subset, filters, Boolean(args.keyword), async ({ params, whereSql }) => {
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
                 AND TRY_CAST(trim(str_split(${q("Coordonnées")}, ',')[1]) AS DOUBLE) BETWEEN -90 AND 90
                 AND TRY_CAST(trim(str_split(${q("Coordonnées")}, ',')[2]) AS DOUBLE) BETWEEN -180 AND 180
               QUALIFY ROW_NUMBER() OVER (PARTITION BY strip_accents(lower(trim(${q("Titre")}))) ORDER BY "o:id") = 1
             ) g ON g.key = v.key`
          : "";

        const rows = await query(
          `WITH v AS (
             SELECT "o:id" AS id, trim(raw) AS place, strip_accents(lower(trim(raw))) AS key
             FROM (SELECT "o:id", ${explode("spatial")} FROM ${viewName(subset)} ${whereSql})
             WHERE NULLIF(trim(raw), '') IS NOT NULL
           )
           SELECT v.place, COUNT(DISTINCT v.id) AS count${geocoded ? ", any_value(g.lat) AS lat, any_value(g.lng) AS lng" : ""}
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
          if (
            lat !== null &&
            lng !== null &&
            Number.isFinite(lat) &&
            Number.isFinite(lng) &&
            Math.abs(lat) <= 90 &&
            Math.abs(lng) <= 180
          ) {
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
        const byCountry =
          subset !== "references" && schema.has("country")
            ? rowsToMap(
                await query(
                  `SELECT trim(raw) AS k, COUNT(DISTINCT "o:id") AS c
                 FROM (SELECT "o:id", ${explode("country")} FROM ${viewName(subset)} ${whereSql})
                 WHERE NULLIF(trim(raw), '') IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1`,
                  params,
                ),
              )
            : {};

        return chartResult({
          view: VIEW.places,
          subset,
          filters: echo,
          total_matches: Number(totals?.n ?? 0),
          items_with_place: Number(totals?.filled ?? 0),
          ...(Object.keys(byCountry).length ? { items_by_country: byCountry } : {}),
          places,
          ...(ungeocoded.length ? { ungeocoded, ungeocoded_mentions: ungeocodedMentions } : {}),
          geocode_coverage: geoCoverage,
          note:
            `The loaded authority index has ${geoCoverage?.geocoded ?? 0} geocoded places of ${geoCoverage?.total ?? 0}. A named ` +
            `place with no geocoded index entry is listed under 'ungeocoded' with its count, not dropped. ` +
            `'spatial' is multi-valued, so counts sum to more than the item count.`,
        });
      });
    },
  );
}
