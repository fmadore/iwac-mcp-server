import { narrowSelection, selectionFrom } from "../../selection.js";
import type { TopicsPayload } from "../../viewContract.js";
// get_topic_distribution → the shape of what a corpus is about.
//
// A treemap of the 30 LDA topics, and — with over_time — a stacked area of how
// the leading ones move through the decades. LDA labels are six hyphenated
// terms ("imam - mosquée - communauté_musulman - prière - fidèle - hadj"),
// which is right for a model reading JSON and far too long for a treemap cell,
// so the chart shows the first terms and keeps the whole label in the tooltip.
import { csv, empty, type ViewResult } from "../shell.js";
import { legend, stackedBar, treemap } from "../svg.js";
import { fmtInt } from "../theme.js";

/** First `n` terms of an LDA label, which is what fits in a cell or a legend. */
export function shortLabel(label: string, n = 3): string {
  const terms = label.split(/\s+-\s+/).filter(Boolean);
  const head = terms.slice(0, n).join(" · ").replaceAll("_", " ");
  return terms.length > n ? `${head}…` : head;
}

export function topicsView(p: TopicsPayload): ViewResult {
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
      // "id@model" when the result spans models that share ids (#84).
      key: t.topic_model ? `${t.topic_id}@${t.topic_model}` : String(t.topic_id),
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
            values: periods.map((y) => series[label]?.[y] ?? 0),
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
      root.querySelectorAll<SVGElement>(".hit[data-key]").forEach((el) => {
        el.addEventListener("click", () => {
          const key = el.getAttribute("data-key");
          if (key === null) return;
          const at = key.indexOf("@");
          const selection = narrowSelection(selectionFrom(p.filters), "topic_id", at < 0 ? key : key.slice(0, at));
          void ctx.run("get_temporal_distribution", {
            subset: p.subset ?? "articles",
            ...(at < 0 ? selection : narrowSelection(selection, "topic_model", key.slice(at + 1))),
          });
        });
      });
    },
  };
}

export type { TopicsPayload } from "../../viewContract.js";
