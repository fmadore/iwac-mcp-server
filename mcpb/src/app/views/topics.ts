// get_topic_distribution → the shape of what a corpus is about.
//
// A treemap of the 30 LDA topics, and — with over_time — a stacked area of how
// the leading ones move through the decades. LDA labels are six hyphenated
// terms ("imam - mosquée - communauté_musulman - prière - fidèle - hadj"),
// which is right for a model reading JSON and far too long for a treemap cell,
// so the chart shows the first terms and keeps the whole label in the tooltip.
import { csv, empty, type BasePayload, type ViewResult } from "../shell.js";
import { legend, stackedBar, treemap } from "../svg.js";
import { fmtInt } from "../theme.js";

interface Topic {
  topic_id?: number;
  label?: string;
  count?: number;
  avg_prob?: number;
}

export interface TopicsPayload extends BasePayload {
  subset?: string;
  filters?: Record<string, unknown>;
  total_matches?: number;
  classified?: number;
  topics?: Topic[];
  periods?: string[];
  series_by_topic?: Record<string, Record<string, number>>;
}

/** First `n` terms of an LDA label, which is what fits in a cell or a legend. */
export function shortLabel(label: string, n = 3): string {
  const terms = label.split(/\s+-\s+/).filter(Boolean);
  const head = terms.slice(0, n).join(" · ").replaceAll("_", " ");
  return terms.length > n ? `${head}…` : head;
}

export function topicsView(payload: BasePayload): ViewResult {
  const p = payload as TopicsPayload;
  const topics = (p.topics ?? []).filter((t) => (t.count ?? 0) > 0);
  if (!topics.length) {
    return {
      title: "Topics",
      chips: p.filters,
      body: empty("No item in this selection carries a topic assignment."),
    };
  }

  const map = treemap({
    items: topics.map((t) => ({
      label: shortLabel(t.label ?? ""),
      value: t.count ?? 0,
      // Full label plus how dominant the topic is where it is assigned.
      note: t.label,
    })),
    height: 320,
    clickable: true,
    ariaLabel: "Articles per LDA topic",
  });

  // Over-time bands, when the tool was asked for them.
  const series = p.series_by_topic;
  const periods = p.periods ?? [];
  const bands = series ? Object.keys(series) : [];
  // "(other topics)" last, so the named bands stay adjacent at the bottom.
  bands.sort((a, b) => Number(a.startsWith("(")) - Number(b.startsWith("(")) || a.localeCompare(b, "fr"));
  const overTime =
    series && periods.length
      ? stackedBar({
          categories: periods,
          series: bands.map((label) => ({
            label: shortLabel(label, 2),
            values: periods.map((y) => series[label][y] ?? 0),
          })),
          height: 260,
          ariaLabel: "Topics over time",
        }) + legend(bands.map((b) => shortLabel(b, 2)))
      : "";

  const classified = p.classified ?? topics.reduce((a, t) => a + (t.count ?? 0), 0);
  const total = p.total_matches ?? classified;

  return {
    title: `Topics in ${p.subset ?? "articles"}`,
    subtitle: `${fmtInt(topics.length)} topics · ${fmtInt(classified)} of ${fmtInt(total)} items classified`,
    chips: p.filters,
    body: map + overTime,
    notes: [
      p.note,
      "Topics come from an LDA model fitted offline over the full text, so they describe what a piece is about " +
        "rather than which words it contains.",
      overTime ? null : "Click a topic to filter the collection to it.",
    ],
    actions: [
      {
        id: "time",
        label: overTime ? "Hide the timeline" : "Show topics over time",
        run: (ctx) =>
          ctx.run("get_topic_distribution", {
            subset: p.subset,
            ...(overTime ? {} : { over_time: true }),
            ...Object.fromEntries(
              Object.entries(p.filters ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== ""),
            ),
          }),
      },
      {
        id: "csv",
        label: "Download CSV",
        run: (ctx) =>
          ctx.download(
            "iwac-topics.csv",
            "text/csv",
            csv([
              ["topic_id", "label", "articles", "avg_probability"],
              ...topics.map((t) => [t.topic_id, t.label, t.count, t.avg_prob]),
            ]),
          ),
      },
    ],
    wire(root, ctx) {
      // The treemap cell carries the SHORT label, so match it back to the full
      // one before handing it to a keyword search.
      const byShort = new Map(topics.map((t) => [shortLabel(t.label ?? ""), t]));
      root.querySelectorAll<SVGElement>(".hit[data-key]").forEach((el) => {
        el.addEventListener("click", () => {
          const topic = byShort.get(el.getAttribute("data-key") ?? "");
          if (!topic?.label) return;
          // The topic's own leading term is the closest thing to a query the
          // aggregate tools accept; searching it keeps the user in charts.
          const term = topic.label.split(/\s+-\s+/)[0]?.replaceAll("_", " ");
          if (term) void ctx.run("get_temporal_distribution", { subset: p.subset ?? "articles", keyword: term });
        });
      });
    },
  };
}
