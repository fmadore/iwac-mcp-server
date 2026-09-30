import type { SimilarPayload } from "../../viewContract.js";
import { csv, empty, type BasePayload, type ViewResult, type ViewOptions } from "../shell.js";
import { horizontalBar } from "../svg.js";
import { clip, esc, fmtNum } from "../theme.js";

export function similarView(payload: BasePayload, options: ViewOptions = {}): ViewResult {
  const p = payload as SimilarPayload,
    neighbours = (p.neighbours ?? []).filter((n) => Number.isFinite(n.score));
  if (!neighbours.length)
    return {
      title: "Similar items",
      body: empty("No valid neighbours meet this threshold; missing embeddings and the display limit restrict recall."),
    };
  const candidates = [...(p.source ? [{ ...p.source, score: 1 }] : []), ...neighbours].sort(
    (a, b) => (a.pub_date || "9999").localeCompare(b.pub_date || "9999") || String(a.id).localeCompare(String(b.id)),
  );
  return {
    title: `Nearest to “${clip(p.source?.title ?? p.source?.id ?? "this item", 60)}”`,
    subtitle: `${neighbours.length} neighbours · ${fmtNum(Number(neighbours[0].score), 2)} down to ${fmtNum(Number(neighbours.at(-1)?.score), 2)}`,
    body: options.timeline
      ? `<ol class="timeline">${candidates.map((n) => `<li><time>${esc(n.pub_date || "Undated")}</time> · ${esc(n.newspaper)} <button data-source="${esc(n.id)}">${esc(n.title || n.id)}</button> · ${fmtNum(Number(n.score), 3)}</li>`).join("")}</ol>`
      : horizontalBar({
          items: neighbours.map((n) => ({
            key: n.id,
            label: n.title ?? n.id ?? "",
            value: Number(n.score),
            note: [n.newspaper, n.pub_date, n.country].filter(Boolean).join(", "),
          })),
          format: (v) => fmtNum(v, 3),
          clickable: true,
          gutter: 300,
          rowHeight: 24,
          ariaLabel: "Cosine similarity to source",
        }),
    notes: [
      p.note,
      "Similarity is a retrieval heuristic, not evidence of copying. The chronology includes the source and its neighbours, not a verified reprint chain. Missing or partial dates limit ordering.",
      "Click a bar to explore its neighbours; use the chronology to read sources.",
    ],
    actions: [
      {
        id: "timeline",
        label: options.timeline ? "Show similarity bars" : "Show candidate chronology",
        run: (ctx) => ctx.setOption("timeline", !options.timeline),
      },
      {
        id: "source",
        label: "Read original source",
        run: (ctx) => ctx.run("fetch", { id: `${p.subset ?? "articles"}:${p.source?.id}` }),
      },
      {
        id: "csv",
        label: "Download CSV",
        run: (ctx) =>
          ctx.download(
            `iwac-similar-${p.source?.id ?? "item"}.csv`,
            "text/csv",
            csv([
              ["id", "title", "score", "newspaper", "date", "url"],
              ...candidates.map((n) => [n.id, n.title, n.score, n.newspaper, n.pub_date, n.url]),
            ]),
          ),
      },
    ],
    wire(root, ctx) {
      root.querySelectorAll<SVGElement>(".hit[data-key]").forEach((el) => {
        el.addEventListener("click", () => {
          void ctx.run("get_similar_items", { id: el.getAttribute("data-key"), subset: p.subset ?? "articles" });
        });
      });
      root.querySelectorAll<HTMLElement>("[data-source]").forEach((el) => {
        el.addEventListener("click", () => {
          void ctx.run("fetch", { id: `${p.subset ?? "articles"}:${el.dataset.source}` });
        });
      });
    },
  };
}
export type { SimilarPayload } from "../../viewContract.js";
