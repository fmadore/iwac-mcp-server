// Browser side of the "coverage over time" MCP App.
//
// Rendered by the host in a sandboxed iframe when get_temporal_distribution is
// called (see src/tools/appUi.ts). It draws the per-year/per-month counts the
// tool already returns, and can re-call the tool to switch granularity or drop
// a filter — the bidirectional half of MCP Apps, which is the reason to do this
// here rather than ship a static image.
//
// Bundled to a single IIFE and inlined into one HTML string at build time
// (scripts/bundle.mjs) because MCP App resources render under a deny-by-default
// CSP: no external stylesheet, font, or script may load.
import { App } from "@modelcontextprotocol/ext-apps";

interface Payload {
  subset?: string;
  granularity?: string;
  group_by?: string;
  filters?: Record<string, unknown>;
  total_matches?: number;
  dated_count?: number;
  undated_count?: number;
  distribution?: Record<string, number>;
  distribution_by_group?: Record<string, Record<string, number>>;
  note?: string;
  error?: string;
}

const app = new App({ name: "IWAC coverage chart", version: "1.0.0" });
const root = document.getElementById("root") as HTMLElement;

/** Last payload rendered, so the toolbar can re-issue the same query. */
let current: Payload = {};

/**
 * The IWAC chart palette, mirrored from the IwacVisualizations Omeka module
 * (`asset/js/iwac-theme.js`: `[--primary, --secondary, ...PALETTE_REST.slice(1)]`)
 * so a country breakdown here is coloured the same way as the equivalent chart
 * on islam.zmo.de. Two sets, because the module resolves `--primary` /
 * `--secondary` per theme and the iframe cannot read the site's CSS variables:
 * slots 0-1 are the theme-dependent brand colours, the rest are the module's
 * hand-picked categorical hues, which already read well in both modes.
 */
const PALETTE_REST = [
  "#4a8c6f", "#c5504d", "#7c5295", "#d4a574", "#2c5f7c",
  "#8b6f47", "#5ba3a0", "#cc8963", "#4a8aab", "#a68e6d",
  "#d49b6a", "#6fb08e", "#9e7bb8", "#e0a88a", "#8e7cb8",
];
const BRAND = {
  light: ["#ce4115", "#394f68"],
  dark: ["#ec653f", "#708093"],
};
const isDark = () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
const palette = (): string[] => [...(isDark() ? BRAND.dark : BRAND.light), ...PALETTE_REST];

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Every bucket key present across one or more series, in sorted order. */
function allBuckets(series: Record<string, number>[]): string[] {
  const keys = new Set<string>();
  for (const s of series) for (const k of Object.keys(s)) keys.add(k);
  return [...keys].sort();
}

function renderChart(p: Payload): string {
  const grouped = p.distribution_by_group;
  const groups = grouped ? Object.keys(grouped).sort() : ["all"];
  const series = grouped ? groups.map((g) => grouped[g]) : [p.distribution ?? {}];
  const buckets = allBuckets(series);
  if (!buckets.length) return `<p class="empty">No dated items match these filters.</p>`;

  // Stacked bars: one column per bucket, one band per group.
  const totals = buckets.map((b) => series.reduce((n, s) => n + (s[b] ?? 0), 0));
  const peak = Math.max(...totals, 1);

  const W = 900;
  const H = 300;
  const PAD = { top: 16, right: 8, bottom: 34, left: 46 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const step = plotW / buckets.length;
  const barW = Math.max(1, Math.min(step * 0.78, 40));

  // Label every bucket while they fit, then thin out to ~14 ticks.
  const tickEvery = Math.max(1, Math.ceil(buckets.length / 14));

  const colors = palette();
  const bars: string[] = [];
  const ticks: string[] = [];
  buckets.forEach((bucket, i) => {
    const x = PAD.left + i * step + (step - barW) / 2;
    let y = PAD.top + plotH;
    series.forEach((s, gi) => {
      const v = s[bucket] ?? 0;
      if (!v) return;
      const h = (v / peak) * plotH;
      y -= h;
      bars.push(
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" ` +
          `fill="${colors[gi % colors.length]}" rx="1"><title>${esc(bucket)}${
            grouped ? ` · ${esc(groups[gi])}` : ""
          }: ${v}</title></rect>`,
      );
    });
    if (i % tickEvery === 0) {
      ticks.push(
        `<text x="${(PAD.left + i * step + step / 2).toFixed(1)}" y="${H - 14}" class="tick" text-anchor="middle">${esc(bucket)}</text>`,
      );
    }
  });

  // Y axis: 0, half, peak.
  const yAxis = [0, Math.round(peak / 2), peak]
    .filter((v, i, a) => a.indexOf(v) === i)
    .map((v) => {
      const y = PAD.top + plotH - (v / peak) * plotH;
      return (
        `<line x1="${PAD.left}" x2="${W - PAD.right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" class="grid"/>` +
        `<text x="${PAD.left - 8}" y="${(y + 4).toFixed(1)}" class="tick" text-anchor="end">${v}</text>`
      );
    })
    .join("");

  const legend = grouped
    ? `<ul class="legend">${groups
        .map(
          (g, i) =>
            `<li><span class="swatch" style="background:${colors[i % colors.length]}"></span>${esc(g)}</li>`,
        )
        .join("")}</ul>`
    : "";

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Items per ${esc(p.granularity ?? "year")}">
      ${yAxis}${bars.join("")}${ticks.join("")}
    </svg>${legend}`;
}

function render(p: Payload): void {
  current = p;
  if (p.error) {
    root.innerHTML = `<p class="empty">${esc(p.error)}</p>`;
    return;
  }
  const filters = Object.entries(p.filters ?? {})
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `<span class="chip">${esc(k)}: ${esc(v)}</span>`)
    .join("");

  const undated = p.undated_count
    ? `<p class="foot">${p.undated_count} matching item${p.undated_count === 1 ? "" : "s"} carry no usable date and are not plotted (they are still counted in the total).</p>`
    : "";
  const note = p.note ? `<p class="foot">${esc(p.note)}</p>` : "";
  const other = (p.granularity ?? "year") === "year" ? "month" : "year";

  root.innerHTML = `
    <header>
      <h1>${esc(p.subset ?? "articles")} per ${esc(p.granularity ?? "year")}</h1>
      <p class="totals"><strong>${p.total_matches ?? 0}</strong> matching · <strong>${p.dated_count ?? 0}</strong> dated${
        p.group_by ? ` · grouped by ${esc(p.group_by)}` : ""
      }</p>
      <div class="chips">${filters || '<span class="chip muted">no filters</span>'}</div>
    </header>
    <div class="chart">${renderChart(p)}</div>
    ${undated}${note}
    <div class="actions"><button id="gran" type="button">Switch to ${other}ly</button></div>
  `;

  const button = document.getElementById("gran") as HTMLButtonElement | null;
  button?.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Loading…";
    try {
      const args: Record<string, unknown> = {
        subset: current.subset,
        granularity: other,
        ...(current.group_by ? { group_by: current.group_by } : {}),
      };
      for (const [k, v] of Object.entries(current.filters ?? {})) {
        if (v !== null && v !== undefined && v !== "") args[k] = v;
      }
      const result = await app.callServerTool({ name: "get_temporal_distribution", arguments: args });
      render(readPayload(result));
    } catch (err) {
      button.disabled = false;
      button.textContent = `Could not reload (${(err as Error).message})`;
    }
  });
}

/** The tool ships the same object as structuredContent AND as JSON text; prefer
 * the structured half and fall back so the app still works if that changes. */
function readPayload(result: unknown): Payload {
  const r = result as { structuredContent?: Payload; content?: { type: string; text?: string }[] };
  if (r?.structuredContent) return r.structuredContent;
  const text = r?.content?.find((c) => c.type === "text")?.text;
  if (!text) return { error: "The tool returned no readable result." };
  try {
    return JSON.parse(text) as Payload;
  } catch {
    return { error: "The tool result was not valid JSON." };
  }
}

app.connect();
app.ontoolresult = (result) => render(readPayload(result));
