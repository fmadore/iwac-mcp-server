// get_place_distribution → where the coverage points, on a map.
//
// Scoped as "choropleth + bubbles", not "a map": under the app CSP there are no
// tiles, no labels layer and no zoom, so this is a static West African frame
// with the vendored Natural Earth outline (src/app/basemap.ts) and one bubble
// per geocoded place.
//
// Two honesty problems the map creates, both answered in the view rather than
// left to the reader:
//
//   * Places outside the frame are NOT drawn. The collection names plenty of
//     them — La Mecque alone is among the most-mentioned places in the corpus —
//     so the off-frame places are counted, disclosed and ranked beside the map.
//   * Only `Lieux` index entries carry coordinates (555 of 683). A place with
//     no geocoded authority record is not on the map and never will be, so it
//     goes in the same ranking rather than silently vanishing.
import { csv, empty, panels, type BasePayload, type ViewResult } from "../shell.js";
import { BASEMAP, BASEMAP_BOUNDS } from "../basemap.js";
import { bubbleMap, horizontalBar } from "../svg.js";
import { fmtInt } from "../theme.js";

interface Place {
  place?: string;
  count?: number;
  lat?: number;
  lng?: number;
}

export interface PlacesPayload extends BasePayload {
  subset?: string;
  filters?: Record<string, unknown>;
  total_matches?: number;
  items_with_place?: number;
  items_by_country?: Record<string, number>;
  places?: Place[];
  ungeocoded?: { place?: string; count?: number }[];
  ungeocoded_mentions?: number;
}

const inFrame = (p: Place): boolean =>
  Number.isFinite(p.lng) &&
  Number.isFinite(p.lat) &&
  (p.lng as number) >= BASEMAP_BOUNDS.west &&
  (p.lng as number) <= BASEMAP_BOUNDS.east &&
  (p.lat as number) >= BASEMAP_BOUNDS.south &&
  (p.lat as number) <= BASEMAP_BOUNDS.north;

const fold = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

/**
 * Country names carry coordinates too — the index geocodes "Côte d'Ivoire" to
 * its centroid — so they arrive as places like any town. Drawing them as
 * bubbles puts a huge blob over each country's middle that means "this country
 * was NAMED n times", right on top of a choropleth that means "this country
 * PUBLISHED m items". Two different quantities in the same spot is unreadable,
 * so country-level mentions get their own panel instead.
 *
 * Matched by name, folded, against the basemap plus the French forms the
 * collection actually uses — explicit and reviewable, unlike guessing from
 * suspiciously round coordinates.
 */
const COUNTRY_NAMES = new Set(
  [
    ...BASEMAP.map((c) => c.name),
    "Bénin",
    "Nigéria",
    "Ghana",
    "Sénégal",
    "Guinée",
    "Tchad",
    "Cameroun",
    "Mauritanie",
    "Algérie",
    "Libye",
    "Gambie",
    "Guinée-Bissau",
    "Sierra Leone",
    "Libéria",
    "Arabie saoudite",
    "France",
    "Maroc",
    "Égypte",
    "Soudan",
    "Tunisie",
    "Mali",
    "Niger",
    "Togo",
  ].map(fold),
);

const isCountryLevel = (p: Place): boolean => COUNTRY_NAMES.has(fold(p.place ?? ""));

export function placesView(payload: BasePayload): ViewResult {
  const p = payload as PlacesPayload;
  const places = (p.places ?? []).filter((x) => (x.count ?? 0) > 0);
  if (!places.length && !p.ungeocoded?.length) {
    return {
      title: "Places named",
      chips: p.filters,
      body: empty("No item in this selection names a place."),
    };
  }

  const countryLevel = places.filter(isCountryLevel);
  const settlements = places.filter((x) => !isCountryLevel(x));
  const plotted = settlements.filter(inFrame);
  const offFrame = settlements.filter((x) => !inFrame(x));

  const map = plotted.length
    ? bubbleMap({
        countries: BASEMAP,
        bounds: BASEMAP_BOUNDS,
        points: plotted.map((x) => ({
          label: x.place ?? "",
          lat: x.lat as number,
          lng: x.lng as number,
          value: x.count ?? 0,
        })),
        choropleth: p.items_by_country,
        clickable: true,
        width: 720,
        ariaLabel: "Places named across West Africa",
      })
    : "";

  // Everything the map cannot show, in one ranking so it is not lost: places
  // beyond the frame, and places the index has never geocoded.
  const elsewhere = [
    ...offFrame.map((x) => ({ label: `${x.place} (off map)`, value: x.count ?? 0 })),
    ...(p.ungeocoded ?? []).map((x) => ({ label: `${x.place} (not geocoded)`, value: x.count ?? 0 })),
  ]
    .sort((a, b) => b.value - a.value)
    .slice(0, 12);

  const elsewhereChart = elsewhere.length
    ? horizontalBar({ items: elsewhere, gutter: 220, width: 560, ariaLabel: "Places not on the map" })
    : "";

  const countryChart = countryLevel.length
    ? horizontalBar({
        items: countryLevel.slice(0, 12).map((x) => ({ label: x.place ?? "", value: x.count ?? 0 })),
        clickable: true,
        gutter: 180,
        width: 520,
        ariaLabel: "Mentions at country level",
      })
    : "";

  const offMentions = offFrame.reduce((a, x) => a + (x.count ?? 0), 0);
  const ungeoMentions = p.ungeocoded_mentions ?? 0;

  return {
    title: "Places named",
    subtitle:
      `${fmtInt(plotted.length)} places mapped · ` +
      `${fmtInt(p.items_with_place ?? 0)} of ${fmtInt(p.total_matches ?? 0)} items name at least one`,
    chips: p.filters,
    body: panels([
      { title: "West Africa", body: map },
      { title: "Named at country level", body: countryChart },
      { title: "Named but not on the map", body: elsewhereChart },
    ]),
    notes: [
      countryLevel.length > 0 &&
        `Country names are geocoded to a centroid, so they would otherwise draw as one huge bubble in each ` +
          `country's middle — meaning "named this often" — directly on top of shading that means "published ` +
          `this much". They are ranked separately instead; the map shows sub-national places only.`,
      offMentions > 0 &&
        (offFrame.length === 1
          ? `1 geocoded place falls outside the West African frame and is not drawn`
          : `${fmtInt(offFrame.length)} geocoded places fall outside the West African frame and are not drawn`) +
          ` — ${fmtInt(offMentions)} mentions, Mecca and the wider Muslim world among them. They are in the ` +
          `ranking beside the map.`,
      ungeoMentions > 0 &&
        `A further ${fmtInt(ungeoMentions)} mentions name places with no geocoded index entry. Only 'Lieux' ` +
          `authority records carry coordinates (555 of 683); persons, organisations and events never will.`,
      "Bubble AREA is proportional to the mention count, not its radius — a radius encoding would square the " +
        "difference and overstate the largest places.",
      p.items_by_country
        ? "Two geographies on one frame: the shading is how many items each country PUBLISHED, the bubbles are " +
          "the places those items NAME. A press that mostly covers itself looks very different from one that " +
          "mostly looks outward."
        : null,
      "Click a country or a bubble to chart its coverage over time.",
      "Coastline: Natural Earth 1:110m, public domain, simplified and inlined — the app CSP forbids map tiles.",
    ],
    actions: [
      {
        id: "csv",
        label: "Download CSV",
        run: (ctx) =>
          ctx.download(
            "iwac-places.csv",
            "text/csv",
            csv([
              ["place", "mentions", "lat", "lng", "on_map"],
              ...places.map((x) => [x.place, x.count, x.lat, x.lng, inFrame(x) ? "yes" : "off frame"]),
              ...(p.ungeocoded ?? []).map((x) => [x.place, x.count, "", "", "not geocoded"]),
            ]),
          ),
      },
    ],
    wire(root, ctx) {
      // Countries filter; individual places have to go through the keyword path
      // because `spatial` is not a filter the temporal tool accepts.
      const countries = new Set(BASEMAP.filter((c) => c.iwac).map((c) => c.name));
      root.querySelectorAll<SVGElement>("[data-key]").forEach((el) => {
        el.addEventListener("click", () => {
          const key = el.getAttribute("data-key");
          if (!key) return;
          void ctx.run("get_temporal_distribution", {
            subset: p.subset ?? "articles",
            ...(countries.has(key) ? { country: key } : { keyword: key }),
          });
        });
      });
    },
  };
}
