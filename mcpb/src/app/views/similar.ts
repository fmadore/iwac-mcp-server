// get_similar_items → the nearest neighbours of one item, by cosine similarity.
//
// The chart is the scores, not the list: a ranked list of titles is something
// text already does well, whereas the SHAPE of the scores is the finding. A
// neighbour at 0.9 with a cliff down to 0.6 means a reprint plus unrelated
// material; a flat run at 0.75 means a genuine cluster of coverage. The 0.85
// reprint line is drawn so that reading is available at a glance.
import { csv, empty, type BasePayload, type ViewResult } from "../shell.js";
import { horizontalBar } from "../svg.js";
import { clip, fmtNum } from "../theme.js";

interface Neighbour {
  id?: string;
  title?: string;
  score?: number;
  newspaper?: string;
  pub_date?: string;
  country?: string;
  url?: string;
}

export interface SimilarPayload extends BasePayload {
  subset?: string;
  source?: { id?: string; title?: string; url?: string };
  neighbours?: Neighbour[];
}

/** At or above this, a neighbour is usually the same story reprinted. */
const REPRINT = 0.85;

export function similarView(payload: BasePayload): ViewResult {
  const p = payload as SimilarPayload;
  const neighbours = (p.neighbours ?? []).filter((n) => Number.isFinite(n.score));
  if (!neighbours.length) {
    return {
      title: "Similar items",
      body: empty("Nothing in this subset is close enough to compare."),
    };
  }

  const reprints = neighbours.filter((n) => (n.score as number) >= REPRINT);
  const top = neighbours[0].score as number;
  const tail = neighbours[neighbours.length - 1].score as number;

  return {
    title: `Nearest to “${clip(p.source?.title ?? p.source?.id ?? "this item", 60)}”`,
    subtitle:
      `${neighbours.length} neighbours · ${fmtNum(top, 2)} down to ${fmtNum(tail, 2)}` +
      (reprints.length ? ` · ${reprints.length} at or above ${REPRINT}` : ""),
    body: horizontalBar({
      items: neighbours.map((n) => ({
        label: n.title ?? n.id ?? "",
        value: n.score as number,
        note: [n.newspaper, n.pub_date?.slice(0, 10), n.country].filter(Boolean).join(", "),
        // The reprint band gets one colour so the cliff is visible without
        // reading a single number.
        color: (n.score as number) >= REPRINT ? "#c5504d" : undefined,
      })),
      format: (v) => fmtNum(v, 3),
      clickable: true,
      gutter: 300,
      rowHeight: 24,
      ariaLabel: "Cosine similarity to the source item",
    }),
    notes: [
      p.note,
      reprints.length
        ? `The ${reprints.length} red bar${reprints.length === 1 ? "" : "s"} at or above ${REPRINT} are the ` +
          `likely reprints. Verify before calling them that: a shared agency dispatch and a rewrite of it score ` +
          `about the same.`
        : `Nothing here reaches ${REPRINT}, so no obvious reprint of this item is in the corpus.`,
      "Click a neighbour to walk on to ITS neighbours.",
    ],
    actions: [
      {
        id: "csv",
        label: "Download CSV",
        run: (ctx) =>
          ctx.download(
            `iwac-similar-${p.source?.id ?? "item"}.csv`,
            "text/csv",
            csv([
              ["id", "title", "score", "newspaper", "date", "url"],
              ...neighbours.map((n) => [n.id, n.title, n.score, n.newspaper, n.pub_date, n.url]),
            ]),
          ),
      },
    ],
    wire(root, ctx) {
      const byTitle = new Map(neighbours.map((n) => [n.title ?? n.id ?? "", n]));
      root.querySelectorAll<SVGElement>(".hit[data-key]").forEach((el) => {
        el.addEventListener("click", () => {
          const next = byTitle.get(el.getAttribute("data-key") ?? "");
          if (next?.id) void ctx.run("get_similar_items", { id: next.id, subset: p.subset ?? "articles" });
        });
      });
    },
  };
}
