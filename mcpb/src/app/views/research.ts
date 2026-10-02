import { narrowSelection, selectionFrom } from "../../selection.js";
import type { AttentionPayload, ComparisonPayload, CoveragePayload, ReaderPayload, RecordsPayload, ResearchPayload } from "../../viewContract.js";
import { csv, empty, panels, type BasePayload, type ViewContext, type ViewResult } from "../shell.js";
import { heatmapMatrix, columns } from "../svg.js";
import { esc, fmtInt } from "../theme.js";

type Row = Record<string, unknown>;
const data = <R extends Row>(p: ResearchPayload<R>): R[] => p.rows ?? [];
const table = (headers: string[], rows: unknown[][]): string =>
  `<div class="scroll"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
const openItems = (ctx: ViewContext, p: ResearchPayload, selection = selectionFrom(p.filters)) =>
  ctx.run("explore_corpus", { mode: "items", subset: p.subset, selection });
const exportRows = (p: ResearchPayload, headers: string[]) => ({
  id: "csv",
  label: "Download CSV",
  run: (ctx: ViewContext) =>
    ctx.download(`iwac-${p.view}.csv`, "text/csv", csv([headers, ...data(p).map((r) => headers.map((k) => Array.isArray(r[k]) ? JSON.stringify(r[k]) : r[k]))])),
});
const detailTable = (p: ResearchPayload, headers: string[]) =>
  `<details><summary>Data table (${data(p).length} rows)</summary>${table(
    headers,
    data(p).map((r) => headers.map((k) => r[k] ?? "—")),
  )}</details>`;

export function recordsView(payload: BasePayload): ViewResult {
  const p = payload as unknown as RecordsPayload;
  const rows = data(p),
    aliases = p.view === "aliases";
  const offset = Number(p.offset ?? 0),
    limit = Number(p.limit ?? 20);
  const filters = p.filters;
  const exported = p.export;
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
      exportRows(p, ["id", "title", "date", "country", "newspaper", "url", "alternate_titles", ...(p.mode === "concordance" ? ["excerpts", "matched_terms", "match_count", "contexts", "source_field", "source_text_sha256", "source_offsets_available"] : [])]),
      ...(exported ? [{
        id: "export", label: `Download ${exported.format}`, capability: "download" as const,
        run: (ctx: ViewContext) => ctx.download(exported.filename, exported.mime_type, exported.content),
      }] : []),
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

export function readerView(payload: BasePayload): ViewResult {
  const p = payload as unknown as ReaderPayload;
  const metadata = (p.metadata ?? {}) as Row;
  return {
    title: String(p.title || p.id || "Source text"),
    chips: { id: p.id },
    body: `${table(
      ["Field", "Value"],
      Object.entries(metadata).filter(([, v]) => typeof v !== "object"),
    )}<p class="citation"><label>Canonical source URL (select to copy)<input class="source-url" aria-label="Canonical source URL" readonly value="${esc(p.url)}" style="display:block;width:100%;font:inherit;color:inherit;background:transparent;border:1px solid var(--line);padding:6px"/></label></p><div class="source-text">${esc(p.text || "No body text available.")}</div>`,
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
        capability: "openLink",
        run: (ctx) => ctx.openLink(p.url),
      },
    ],
    wire(root) {
      const url = root.querySelector<HTMLInputElement>(".source-url");
      url?.addEventListener("focus", () => url.select?.());
      url?.addEventListener("click", () => url.select?.());
    },
  };
}

export function coverageView(payload: BasePayload, options: Row): ViewResult {
  const p = payload as unknown as CoveragePayload;
  const rows = data(p);
  const metrics = ["fulltext", "embedded", "scored", "total"] as const;
  const available = metrics.filter((m) => m === "total" || rows.some((r) => typeof r[m] === "number"));
  const requested = options.metric;
  const metric = available.find((m) => m === requested) ?? available[0];
  const nextMetric = available[(available.indexOf(metric) + 1) % available.length];
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
                : typeof r[metric] === "number" && r.total > 0 ? (100 * r[metric]) / r.total : Number.NaN
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
      available.length < metrics.length ? `Unavailable metrics: ${metrics.filter((m) => !available.includes(m)).join(", ")}. Missing measurements are not zero.` : undefined,
      Number(p.omitted_cells) > 0
        ? `${p.omitted_cells} lower-count populated cells omitted; blank cells can therefore include omitted data.`
        : undefined,
    ],
    actions: [
      {
        id: "metric",
        label: `Show ${nextMetric}`,
        run: (ctx) => ctx.setOption("metric", nextMetric),
      },
      exportRows(p, ["source", "year", "total", "fulltext", "embedded", "scored"]),
    ],
    wire(root, ctx) {
      root.querySelectorAll<HTMLElement>(".hit[data-key]").forEach((el) => {
        el.addEventListener("click", () => {
          const source = el.dataset.key,
            year = el.dataset.key2;
          if (!source || !year || year === "(undated)" || el.dataset.key === "(missing)") return;
          let selection = narrowSelection(selectionFrom(p.filters as Row), p.source_exact_field ?? p.source_field, source);
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

export function comparisonView(payload: BasePayload): ViewResult {
  const p = payload as unknown as ComparisonPayload;
  const rows = data(p),
    selections = p.selections ?? [];
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
  const temporal = p.temporal;
  const years = [...new Set(temporal?.rows.map((r) => r.year) ?? [])];
  const trend = temporal?.rows.length ? panels([{
    title: "Selection share of the archived corpus per year (%)",
    body: `${columns({
      categories: years,
      series: ["A", "B"].map((label) => ({ label, values: years.map((year) => 100 * (temporal.rows.find((r) => r.selection === label && r.year === year)?.share ?? 0)) })),
      mode: "grouped", ariaLabel: "Two selections as a share of the archived corpus per year (%)",
    })}<details><summary>Yearly counts and denominators</summary>${table(["Selection", "Year", "Count", "Archived corpus", "Share"], temporal.rows.map((r) => [r.selection, r.year, r.count, r.denominator, r.share]))}</details>`,
  }]) : "";
  return {
    title: "Compare two selections",
    subtitle: `${fmtInt(Number(p.overlap))} items belong to both selections`,
    body:
      table(
        ["Selection", "Items", "Body text", "Embedded", "Scored"],
        selections.map((s) => [s.label, s.total, s.fulltext, s.embedded, s.scored]),
      ) +
      panels(plots) + trend +
      detailTable(p, ["selection", "field", "value", "count", "share"]),
    notes: [
      p.note,
      temporal?.note,
      temporal && temporal.omitted_years > 0 ? `${temporal.omitted_years} corpus year buckets omitted from the timeline.` : undefined,
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

export function attentionView(payload: BasePayload, options: Row): ViewResult {
  const p = payload as unknown as AttentionPayload;
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
