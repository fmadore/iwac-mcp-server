import { narrowSelection, selectionFrom } from "../../selection.js";
import { csv, empty, panels, type BasePayload, type ViewContext, type ViewResult } from "../shell.js";
import { heatmapMatrix, columns } from "../svg.js";
import { esc, fmtInt } from "../theme.js";

type Row = Record<string, unknown>;
const data = (p: BasePayload) => (p.rows ?? []) as Row[];
const table = (headers: string[], rows: unknown[][]): string =>
  `<div class="scroll"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
const openItems = (ctx: ViewContext, p: BasePayload, selection = selectionFrom(p.filters as Row)) =>
  ctx.run("explore_corpus", { mode: "items", subset: p.subset, selection });
const exportRows = (p: BasePayload, headers: string[]) => ({
  id: "csv",
  label: "Download CSV",
  run: (ctx: ViewContext) =>
    ctx.download(`iwac-${p.view}.csv`, "text/csv", csv([headers, ...data(p).map((r) => headers.map((k) => r[k]))])),
});
const detailTable = (p: BasePayload, headers: string[]) =>
  `<details><summary>Data table (${data(p).length} rows)</summary>${table(
    headers,
    data(p).map((r) => headers.map((k) => r[k])),
  )}</details>`;

export function recordsView(p: BasePayload): ViewResult {
  const rows = data(p),
    aliases = p.view === "aliases";
  const offset = Number(p.offset ?? 0),
    limit = Number(p.limit ?? 20);
  const filters = p.filters as Row;
  return {
    title: aliases ? "Authority aliases" : p.mode === "concordance" ? "Keyword in context" : "Source items",
    subtitle: `${fmtInt(Number(p.total_matches ?? 0))} matching · ${rows.length ? offset + 1 : 0}–${offset + rows.length}`,
    chips: filters,
    body: rows.length
      ? rows
          .map(
            (r) =>
              `<article class="record"><button class="source" data-id="${esc(r.id)}">${esc(r.title || r.id)}</button><p>${esc([r.date, r.newspaper, r.country].filter(Boolean).join(" · "))}</p>${r.alternate_titles ? `<p>Aliases: ${esc(r.alternate_titles)}</p>` : ""}${Array.isArray(r.excerpts) ? r.excerpts.map((t) => `<blockquote>${esc(t)}</blockquote>`).join("") || "<p>No literal match in available body text.</p>" : ""}</article>`,
          )
          .join("")
      : empty("No items match this selection."),
    notes: [p.note],
    actions: [
      ...(offset
        ? [
            {
              id: "previous",
              label: "Previous page",
              run: (ctx: ViewContext) =>
                ctx.run("explore_corpus", {
                  mode: p.mode,
                  subset: p.subset,
                  selection: selectionFrom(filters),
                  offset: Math.max(0, offset - limit),
                  limit,
                }),
            },
          ]
        : []),
      ...(p.has_more
        ? [
            {
              id: "next",
              label: "Next page",
              run: (ctx: ViewContext) =>
                ctx.run("explore_corpus", {
                  mode: p.mode,
                  subset: p.subset,
                  selection: selectionFrom(filters),
                  offset: offset + limit,
                  limit,
                }),
            },
          ]
        : []),
      ...(filters?.keyword && p.mode === "items"
        ? [
            {
              id: "context",
              label: "Show keyword contexts",
              run: (ctx: ViewContext) =>
                ctx.run("explore_corpus", {
                  mode: "concordance",
                  subset: p.subset,
                  selection: selectionFrom(filters),
                  offset,
                  limit,
                }),
            },
          ]
        : []),
      exportRows(p, ["id", "title", "date", "country", "newspaper", "url", "alternate_titles"]),
    ],
    wire(root, ctx) {
      root.querySelectorAll<HTMLElement>("[data-id]").forEach((el) => {
        el.addEventListener("click", () => {
          void ctx.run("fetch", { id: el.dataset.id });
        });
      });
    },
  };
}

export function readerView(p: BasePayload): ViewResult {
  const metadata = (p.metadata ?? {}) as Row;
  return {
    title: String(p.title || p.id || "Source text"),
    chips: { id: p.id },
    body: `${table(
      ["Field", "Value"],
      Object.entries(metadata).filter(([, v]) => typeof v !== "object"),
    )}<p class="citation">${esc(p.url)}</p><div class="source-text">${esc(p.text || "No body text available.")}</div>`,
    notes: [
      p.text_source === "description"
        ? "This is a catalogue description, not a transcription or full source text."
        : undefined,
      p.note,
      p.text_truncated
        ? "Text is truncated. Use the canonical source or a keyword excerpt tool for further reading."
        : undefined,
    ],
    actions: [
      {
        id: "source",
        label: "Open canonical source",
        run: (ctx) => (ctx.canOpenLink ? ctx.openLink(String(p.url)) : ctx.setOption("link", p.url)),
      },
    ],
  };
}

export function coverageView(p: BasePayload, options: Row): ViewResult {
  const rows = data(p),
    metric = String(options.metric ?? "fulltext");
  const sources = [...new Set(rows.map((r) => String(r.source)))].sort(),
    years = [...new Set(rows.map((r) => String(r.year)))].sort();
  const lookup = new Map(rows.map((r) => [JSON.stringify([r.source, r.year]), r]));
  const body = rows.length
    ? heatmapMatrix({
        rows: sources,
        cols: years,
        values: sources.map((s) =>
          years.map((y) => {
            const r = lookup.get(JSON.stringify([s, y]));
            return r
              ? metric === "total"
                ? Number(r.total)
                : (100 * Number(r[metric])) / Number(r.total)
              : Number.NaN;
          }),
        ),
        format: (v) => (metric === "total" ? fmtInt(v) : `${v.toFixed(1)}%`),
        clickable: true,
        ariaLabel: `${metric} coverage by source and year`,
      })
    : empty("No coverage cells for this selection.");
  return {
    title: "Source coverage over time",
    subtitle: `${fmtInt(Number(p.total_matches))} selected items · ${metric === "total" ? "archived counts" : `${metric} / archived items (%)`}`,
    chips: p.filters as Row,
    body: body + detailTable(p, ["source", "year", "total", "fulltext", "embedded", "scored"]),
    notes: [
      p.note,
      Number(p.omitted_cells) > 0
        ? `${p.omitted_cells} lower-count populated cells omitted; blank cells can therefore include omitted data.`
        : undefined,
    ],
    actions: [
      {
        id: "metric",
        label: `Show ${metric === "fulltext" ? "embedded" : metric === "embedded" ? "scored" : metric === "scored" ? "total" : "fulltext"}`,
        run: (ctx) =>
          ctx.setOption(
            "metric",
            metric === "fulltext"
              ? "embedded"
              : metric === "embedded"
                ? "scored"
                : metric === "scored"
                  ? "total"
                  : "fulltext",
          ),
      },
      exportRows(p, ["source", "year", "total", "fulltext", "embedded", "scored"]),
    ],
    wire(root, ctx) {
      root.querySelectorAll<HTMLElement>(".hit[data-key]").forEach((el) => {
        el.addEventListener("click", () => {
          const source = el.dataset.key,
            year = el.dataset.key2;
          if (!source || !year || year === "(undated)" || el.dataset.key === "(missing)") return;
          let selection = narrowSelection(selectionFrom(p.filters as Row), String(p.source_field), source);
          selection = {
            ...selection,
            date_from: selection.date_from && selection.date_from > year ? selection.date_from : year,
            date_to: selection.date_to && selection.date_to < `${year}-12-31` ? selection.date_to : `${year}-12-31`,
          };
          void openItems(ctx, p, selection);
        });
      });
    },
  };
}

export function comparisonView(p: BasePayload): ViewResult {
  const rows = data(p),
    selections = (p.selections ?? []) as Row[];
  const plots = [...new Set(rows.map((r) => String(r.field)))].map((field) => {
    const part = rows.filter((r) => r.field === field),
      categories = [...new Set(part.map((r) => String(r.value)))];
    return {
      title: `${field} — share (%)`,
      body: columns({
        categories,
        series: ["A", "B"].map((label) => ({
          label,
          values: categories.map(
            (c) => 100 * Number(part.find((r) => r.selection === label && r.value === c)?.share ?? 0),
          ),
        })),
        mode: "grouped",
        ariaLabel: `Selection shares by ${field} (%)`,
      }),
    };
  });
  return {
    title: "Compare two selections",
    subtitle: `${fmtInt(Number(p.overlap))} items belong to both selections`,
    body:
      table(
        ["Selection", "Items", "Body text", "Embedded", "Scored"],
        selections.map((s) => [s.label, s.total, s.fulltext, s.embedded, s.scored]),
      ) +
      panels(plots) +
      detailTable(p, ["selection", "field", "value", "count", "share"]),
    notes: [
      p.note,
      Number(p.omitted_cells) > 0
        ? `${p.omitted_cells} category cells omitted. Shares still use each full base.`
        : undefined,
    ],
    actions: [
      ...selections.map((s) => ({
        id: `read-${s.label}`,
        label: `Read selection ${s.label}`,
        run: (ctx: ViewContext) => openItems(ctx, p, selectionFrom(s.filters as Row)),
      })),
      exportRows(p, ["selection", "field", "value", "count", "share"]),
    ],
  };
}

export function attentionView(p: BasePayload, options: Row): ViewResult {
  const rows = data(p),
    origins = [...new Set(rows.map((r) => String(r.origin)))].sort(),
    destinations = [...new Set(rows.map((r) => String(r.destination)))].sort(),
    percent = Boolean(options.percent);
  const lookup = new Map(rows.map((r) => [JSON.stringify([r.origin, r.destination]), r]));
  return {
    title: "Where publications direct attention",
    chips: p.filters as Row,
    body: rows.length
      ? heatmapMatrix({
          rows: origins,
          cols: destinations,
          values: origins.map((a) =>
            destinations.map((b) => {
              const r = lookup.get(JSON.stringify([a, b]));
              return r ? (percent ? (100 * Number(r.count)) / Number(r.denominator) : Number(r.count)) : Number.NaN;
            }),
          ),
          format: (v) => (percent ? `${v.toFixed(1)}%` : fmtInt(v)),
          clickable: true,
          ariaLabel: "Publication countries and mentioned places",
        }) + detailTable(p, ["origin", "destination", "count", "denominator"])
      : empty("No tagged origin–place pairs."),
    notes: [p.note, Number(p.omitted_cells) > 0 ? `${p.omitted_cells} smaller pairs omitted.` : undefined],
    actions: [
      {
        id: "percent",
        label: percent ? "Show counts" : "Show share of origin's items",
        run: (ctx) => ctx.setOption("percent", !percent),
      },
      exportRows(p, ["origin", "destination", "count", "denominator"]),
    ],
    wire(root, ctx) {
      root.querySelectorAll<HTMLElement>(".hit[data-key]").forEach((el) => {
        el.addEventListener("click", () => {
          const origin = el.dataset.key,
            destination = el.dataset.key2;
          if (!origin || !destination) return;
          let s = narrowSelection(selectionFrom(p.filters as Row), "country", origin);
          s = narrowSelection(s, "spatial", destination);
          void openItems(ctx, p, s);
        });
      });
    },
  };
}
