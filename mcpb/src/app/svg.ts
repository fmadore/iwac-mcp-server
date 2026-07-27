// The SVG chart kernel: hand-rolled primitives, no charting library.
//
// MCP App resources render under a deny-by-default CSP, so nothing can be
// fetched — not ECharts, not a stylesheet, not a font. Every primitive here
// returns a self-contained `<svg>` STRING, which the views concatenate into the
// page. That keeps each chart a pure function of its data (trivially testable
// in Node with no DOM) and keeps the shared app bundle small: the whole kernel
// is a few kb, against ~1 MB for an inlined ECharts.
//
// The vocabulary deliberately mirrors the subset of the IwacVisualizations
// module's `C.*` helpers that survives the CSP, so a chart here and the same
// chart on islam.zmo.de stay recognisably related.
//
// Interactivity convention: clickable marks carry `data-key` (and sometimes
// `data-key2`); views attach ONE delegated listener rather than N handlers.
import { clip, esc, fmtInt, fmtNum, palette, ramp } from "./theme.js";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Frame {
  /** viewBox width; the SVG scales to the container, so this is aspect, not px. */
  width?: number;
  height?: number;
  /** CSS min-width, below which the chart scrolls horizontally instead of squashing. */
  minWidth?: number;
  ariaLabel: string;
}

const PAD = { top: 16, right: 10, bottom: 34, left: 52 };

/** Wrap chart body markup in a sized, labelled `<svg>`. */
export function frame(body: string, f: Frame): string {
  const w = f.width ?? 900;
  const h = f.height ?? 300;
  const min = f.minWidth ?? 520;
  return (
    `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(f.ariaLabel)}" style="min-width:${min}px">` +
    `${body}</svg>`
  );
}

const n = (v: number): string => (Math.round(v * 10) / 10).toString();

/**
 * Axis ticks at 1/2/2.5/5×10ⁿ, and the rounded-up maximum they imply. Charts
 * scale to that maximum rather than to the raw peak, so the top gridline is a
 * round number instead of "12 287".
 *
 * 2.5 earns its place in the ladder: without it a peak of 97 rounds to a step
 * of 50 and the axis degenerates to 0/50/100, where 0/25/50/75/100 reads the
 * intermediate values far better.
 */
export function ticks(peak: number, count = 4): { max: number; values: number[] } {
  if (!(peak > 0)) return { max: 1, values: [0, 1] };
  const rough = peak / count;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough) ?? 10 * mag;
  const max = Math.ceil(peak / step) * step;
  const values: number[] = [];
  for (let v = 0; v <= max + step / 2; v += step) values.push(Math.round(v * 1e6) / 1e6);
  return { max, values };
}

/** Horizontal gridlines + left-hand value labels. */
function yAxis(max: number, values: number[], plot: Box, fmt: (v: number) => string): string {
  return values
    .map((v) => {
      const y = plot.y + plot.h - (v / max) * plot.h;
      return (
        `<line x1="${n(plot.x)}" x2="${n(plot.x + plot.w)}" y1="${n(y)}" y2="${n(y)}" class="grid"/>` +
        `<text x="${n(plot.x - 8)}" y="${n(y + 4)}" class="tick" text-anchor="end">${esc(fmt(v))}</text>`
      );
    })
    .join("");
}

/** Category labels along the bottom, thinned so they never overlap. */
function xAxis(categories: string[], plot: Box, height: number, maxTicks = 14): string {
  const step = plot.w / categories.length;
  const every = Math.max(1, Math.ceil(categories.length / maxTicks));
  return categories
    .map((c, i) =>
      i % every === 0
        ? `<text x="${n(plot.x + i * step + step / 2)}" y="${height - 14}" class="tick" text-anchor="middle">${esc(clip(c, 14))}</text>`
        : "",
    )
    .join("");
}

export interface Series {
  label: string;
  /** One value per category; missing entries count as 0. */
  values: number[];
  color?: string;
}

export interface ColumnOptions extends Partial<Frame> {
  categories: string[];
  series: Series[];
  mode?: "stacked" | "grouped";
  /** Formats the y-axis labels and tooltips. */
  format?: (v: number) => string;
  /** Emitted as `data-key` on every bar, for delegated click handling. */
  clickable?: boolean;
  maxTicks?: number;
}

/**
 * Vertical bars — the workhorse. `stacked` sums the series per category (one
 * column, bands within it); `grouped` puts them side by side.
 */
export function columns(o: ColumnOptions): string {
  const { categories, series } = o;
  const width = o.width ?? 900;
  const height = o.height ?? 300;
  const fmt = o.format ?? fmtInt;
  const mode = o.mode ?? "stacked";
  if (!categories.length || !series.length) return "";

  const plot: Box = {
    x: PAD.left,
    y: PAD.top,
    w: width - PAD.left - PAD.right,
    h: height - PAD.top - PAD.bottom,
  };
  const peak =
    mode === "stacked"
      ? Math.max(...categories.map((_, i) => series.reduce((a, s) => a + (s.values[i] || 0), 0)))
      : Math.max(...series.flatMap((s) => s.values.map((v) => v || 0)));
  const scale = ticks(peak, 4);

  const colors = palette();
  const step = plot.w / categories.length;
  const slot = Math.max(1, Math.min(step * 0.78, mode === "grouped" ? 40 * series.length : 40));
  const barW = mode === "grouped" ? slot / series.length : slot;

  const bars: string[] = [];
  categories.forEach((cat, i) => {
    const left = plot.x + i * step + (step - slot) / 2;
    let stackY = plot.y + plot.h;
    series.forEach((s, si) => {
      const v = s.values[i] || 0;
      if (!v) return;
      const h = (v / scale.max) * plot.h;
      const x = mode === "grouped" ? left + si * barW : left;
      if (mode !== "grouped") stackY -= h;
      const y = mode === "grouped" ? plot.y + plot.h - h : stackY;
      const title = series.length > 1 ? `${cat} · ${s.label}: ${fmt(v)}` : `${cat}: ${fmt(v)}`;
      bars.push(
        `<rect x="${n(x)}" y="${n(y)}" width="${n(Math.max(1, barW - (mode === "grouped" ? 1 : 0)))}" height="${n(h)}" ` +
          `fill="${s.color ?? colors[si % colors.length]}" rx="1"${
            o.clickable ? ` class="hit" data-key="${esc(cat)}" data-key2="${esc(s.label)}"` : ""
          }><title>${esc(title)}</title></rect>`,
      );
    });
  });

  return frame(
    yAxis(scale.max, scale.values, plot, fmt) + bars.join("") + xAxis(categories, plot, height, o.maxTicks),
    { width, height, minWidth: o.minWidth, ariaLabel: o.ariaLabel ?? "Bar chart" },
  );
}

/** Single-series convenience wrapper over {@link columns}. */
export function bar(o: Omit<ColumnOptions, "series" | "mode"> & { values: number[]; label?: string }): string {
  return columns({ ...o, series: [{ label: o.label ?? "count", values: o.values }], mode: "stacked" });
}

/** Multi-series convenience wrapper over {@link columns}. */
export function stackedBar(o: ColumnOptions): string {
  return columns({ ...o, mode: "stacked" });
}

export interface RankItem {
  label: string;
  value: number;
  /** Optional right-hand annotation (e.g. a date range). */
  note?: string;
  color?: string;
}

export interface HorizontalBarOptions extends Partial<Frame> {
  items: RankItem[];
  format?: (v: number) => string;
  clickable?: boolean;
  /** Label gutter in viewBox units. Widen for long newspaper titles. */
  gutter?: number;
  rowHeight?: number;
}

/** Ranked horizontal bars: labels in a left gutter, value at the bar's end. */
export function horizontalBar(o: HorizontalBarOptions): string {
  const items = o.items;
  if (!items.length) return "";
  const fmt = o.format ?? fmtInt;
  const rowH = o.rowHeight ?? 22;
  const width = o.width ?? 900;
  const gutter = o.gutter ?? 190;
  const height = o.height ?? items.length * rowH + 16;
  const right = 70; // room for the value label
  const plotW = width - gutter - right;
  const scale = ticks(Math.max(...items.map((i) => i.value)), 4);
  const colors = palette();

  const rows = items
    .map((it, i) => {
      const y = 8 + i * rowH;
      const w = Math.max(1, (it.value / scale.max) * plotW);
      return (
        `<text x="${gutter - 8}" y="${n(y + rowH / 2 + 4)}" class="tick lbl" text-anchor="end">${esc(clip(it.label, 30))}</text>` +
        `<rect x="${gutter}" y="${n(y + 3)}" width="${n(w)}" height="${n(rowH - 8)}" rx="1" ` +
        `fill="${it.color ?? colors[i % colors.length]}"${
          o.clickable ? ` class="hit" data-key="${esc(it.label)}"` : ""
        }><title>${esc(it.label)}: ${esc(fmt(it.value))}${it.note ? ` (${esc(it.note)})` : ""}</title></rect>` +
        `<text x="${n(gutter + w + 6)}" y="${n(y + rowH / 2 + 4)}" class="tick">${esc(fmt(it.value))}</text>`
      );
    })
    .join("");

  return frame(rows, {
    width,
    height,
    minWidth: o.minWidth ?? 480,
    ariaLabel: o.ariaLabel ?? "Ranked bar chart",
  });
}

export interface GanttRow {
  label: string;
  start: number;
  end: number;
  /** Drives bar thickness — e.g. how many issues fall inside the run. */
  weight?: number;
  note?: string;
}

export interface GanttOptions extends Partial<Frame> {
  rows: GanttRow[];
  gutter?: number;
  rowHeight?: number;
  clickable?: boolean;
}

/**
 * Runs on a shared numeric (year) axis. Bar thickness encodes `weight`, which
 * is how a run of 695 issues reads differently from a run of 12 across the same
 * span — the span alone would draw them identically.
 */
export function gantt(o: GanttOptions): string {
  const rows = o.rows;
  if (!rows.length) return "";
  const rowH = o.rowHeight ?? 20;
  const width = o.width ?? 900;
  const gutter = o.gutter ?? 190;
  const height = o.height ?? rows.length * rowH + 34;
  const plot: Box = { x: gutter, y: 8, w: width - gutter - 16, h: rows.length * rowH };

  const lo = Math.min(...rows.map((r) => r.start));
  const hi = Math.max(...rows.map((r) => r.end));
  const span = Math.max(1, hi - lo);
  const at = (year: number): number => plot.x + ((year - lo) / span) * plot.w;

  const maxWeight = Math.max(1, ...rows.map((r) => r.weight ?? 1));
  const colors = palette();

  // Decade gridlines, thinned to at most ~12 so a 120-year span stays readable.
  const stepYears = Math.max(1, Math.ceil(span / 12 / 10) * 10);
  const grid: string[] = [];
  for (let y = Math.ceil(lo / stepYears) * stepYears; y <= hi; y += stepYears) {
    grid.push(
      `<line x1="${n(at(y))}" x2="${n(at(y))}" y1="${plot.y}" y2="${n(plot.y + plot.h)}" class="grid"/>` +
        `<text x="${n(at(y))}" y="${n(plot.y + plot.h + 18)}" class="tick" text-anchor="middle">${y}</text>`,
    );
  }

  const bars = rows
    .map((r, i) => {
      const y = plot.y + i * rowH;
      const thick = 4 + ((rowH - 10) * Math.sqrt(r.weight ?? 1)) / Math.sqrt(maxWeight);
      const x1 = at(r.start);
      const x2 = at(r.end);
      const span1 = Math.max(2, x2 - x1);
      const label = `${r.label}: ${r.start}–${r.end}${r.weight ? ` · ${fmtInt(r.weight)} issues` : ""}`;
      return (
        `<text x="${gutter - 8}" y="${n(y + rowH / 2 + 4)}" class="tick lbl" text-anchor="end">${esc(clip(r.label, 30))}</text>` +
        `<rect x="${n(x1)}" y="${n(y + (rowH - thick) / 2)}" width="${n(span1)}" height="${n(thick)}" rx="${n(Math.min(3, thick / 2))}" ` +
        `fill="${colors[i % colors.length]}"${
          o.clickable ? ` class="hit" data-key="${esc(r.label)}"` : ""
        }><title>${esc(label)}${r.note ? ` — ${esc(r.note)}` : ""}</title></rect>`
      );
    })
    .join("");

  return frame(grid.join("") + bars, {
    width,
    height,
    minWidth: o.minWidth ?? 560,
    ariaLabel: o.ariaLabel ?? "Publication runs over time",
  });
}

export interface Slice {
  label: string;
  value: number;
  color?: string;
}

export interface DonutOptions extends Partial<Frame> {
  slices: Slice[];
  /** Big number in the hole; defaults to the total. */
  centerValue?: string;
  centerLabel?: string;
  size?: number;
}

/** Ring chart. Slices below 0.5% of the total are merged so labels stay legible. */
export function donut(o: DonutOptions): string {
  const total = o.slices.reduce((a, s) => a + s.value, 0);
  if (total <= 0) return "";
  const size = o.size ?? 190;
  const r = size / 2 - 6;
  const inner = r * 0.62;
  const cx = size / 2;
  const cy = size / 2;
  const colors = palette();

  let angle = -Math.PI / 2;
  const arcs = o.slices
    .filter((s) => s.value > 0)
    .map((s, i) => {
      const sweep = (s.value / total) * Math.PI * 2;
      const a0 = angle;
      angle += sweep;
      const a1 = angle;
      const large = sweep > Math.PI ? 1 : 0;
      // A full-circle single slice degenerates to a zero-length path; nudge it.
      const end = sweep >= Math.PI * 2 - 1e-6 ? a1 - 1e-4 : a1;
      const p = (rad: number, ang: number) => `${n(cx + rad * Math.cos(ang))} ${n(cy + rad * Math.sin(ang))}`;
      const d =
        `M ${p(r, a0)} A ${n(r)} ${n(r)} 0 ${large} 1 ${p(r, end)} ` +
        `L ${p(inner, end)} A ${n(inner)} ${n(inner)} 0 ${large} 0 ${p(inner, a0)} Z`;
      return (
        `<path d="${d}" fill="${s.color ?? colors[i % colors.length]}">` +
        `<title>${esc(s.label)}: ${fmtInt(s.value)} (${fmtNum((s.value / total) * 100, 1)}%)</title></path>`
      );
    })
    .join("");

  const center =
    `<text x="${cx}" y="${cy + (o.centerLabel ? 0 : 6)}" text-anchor="middle" class="big">${esc(o.centerValue ?? fmtInt(total))}</text>` +
    (o.centerLabel
      ? `<text x="${cx}" y="${cy + 17}" text-anchor="middle" class="tick">${esc(o.centerLabel)}</text>`
      : "");

  return frame(arcs + center, {
    width: size,
    height: size,
    minWidth: o.minWidth ?? size,
    ariaLabel: o.ariaLabel ?? "Donut chart",
  });
}

/**
 * Squarified treemap layout (Bruls, Huizing & van Wijk 2000). Returns one box
 * per input value, in input order, laid out to keep cells close to square.
 */
export function squarify(values: number[], rect: Box): Box[] {
  const out: Box[] = values.map(() => ({ x: rect.x, y: rect.y, w: 0, h: 0 }));
  const total = values.reduce((a, b) => a + Math.max(0, b), 0);
  if (total <= 0 || rect.w <= 0 || rect.h <= 0) return out;

  // Descending order is what makes the layout squarish; remember the mapping.
  const order = values.map((_v, i) => i).sort((a, b) => values[b] - values[a]);
  const area = values.map((v) => (Math.max(0, v) / total) * rect.w * rect.h);

  let free: Box = { ...rect };
  let row: number[] = [];
  let rowArea = 0;

  const worst = (extra: number): number => {
    const side = Math.min(free.w, free.h);
    const sum = rowArea + extra;
    if (sum <= 0 || side <= 0) return Number.POSITIVE_INFINITY;
    const areas = row.map((i) => area[i]).concat(extra > 0 ? [extra] : []);
    const max = Math.max(...areas);
    const min = Math.min(...areas);
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };

  const flushRow = (): void => {
    if (!row.length) return;
    const side = Math.min(free.w, free.h);
    const thickness = rowArea / side;
    let offset = 0;
    const horizontal = free.w >= free.h;
    for (const i of row) {
      const length = (area[i] / rowArea) * side;
      out[i] = horizontal
        ? { x: free.x, y: free.y + offset, w: thickness, h: length }
        : { x: free.x + offset, y: free.y, w: length, h: thickness };
      offset += length;
    }
    free = horizontal
      ? { x: free.x + thickness, y: free.y, w: free.w - thickness, h: free.h }
      : { x: free.x, y: free.y + thickness, w: free.w, h: free.h - thickness };
    row = [];
    rowArea = 0;
  };

  for (const i of order) {
    if (area[i] <= 0) continue;
    if (row.length && worst(area[i]) > worst(0)) flushRow();
    row.push(i);
    rowArea += area[i];
  }
  flushRow();
  return out;
}

export interface TreemapOptions extends Partial<Frame> {
  items: RankItem[];
  format?: (v: number) => string;
  clickable?: boolean;
}

/** Proportional area map — good for "how big is each subset / topic". */
export function treemap(o: TreemapOptions): string {
  const items = o.items.filter((i) => i.value > 0);
  if (!items.length) return "";
  const width = o.width ?? 900;
  const height = o.height ?? 320;
  const fmt = o.format ?? fmtInt;
  const boxes = squarify(
    items.map((i) => i.value),
    { x: 1, y: 1, w: width - 2, h: height - 2 },
  );
  const colors = palette();

  const cells = items
    .map((it, i) => {
      const b = boxes[i];
      if (b.w < 1 || b.h < 1) return "";
      // Only label cells with room for it; the <title> covers the rest.
      const showLabel = b.w > 58 && b.h > 26;
      const showValue = b.w > 58 && b.h > 40;
      return (
        `<g${o.clickable ? ` class="hit" data-key="${esc(it.label)}"` : ""}>` +
        `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w - 1)}" height="${n(b.h - 1)}" rx="2" fill="${it.color ?? colors[i % colors.length]}">` +
        `<title>${esc(it.label)}: ${esc(fmt(it.value))}</title></rect>` +
        (showLabel
          ? `<text x="${n(b.x + 7)}" y="${n(b.y + 17)}" class="cell">${esc(clip(it.label, Math.floor(b.w / 7)))}</text>`
          : "") +
        (showValue ? `<text x="${n(b.x + 7)}" y="${n(b.y + 33)}" class="cell dim">${esc(fmt(it.value))}</text>` : "") +
        `</g>`
      );
    })
    .join("");

  return frame(cells, { width, height, minWidth: o.minWidth ?? 420, ariaLabel: o.ariaLabel ?? "Treemap" });
}

export interface MatrixOptions extends Partial<Frame> {
  rows: string[];
  cols: string[];
  /** values[rowIndex][colIndex]; non-finite entries render as an empty cell. */
  values: number[][];
  format?: (v: number) => string;
  clickable?: boolean;
  gutter?: number;
  cell?: number;
}

/** Co-occurrence / agreement matrix on a sequential ramp. */
export function heatmapMatrix(o: MatrixOptions): string {
  const { rows, cols, values } = o;
  if (!rows.length || !cols.length) return "";
  const fmt = o.format ?? fmtInt;
  const gutter = o.gutter ?? 150;
  const cell = o.cell ?? 26;
  const topLabels = 62;
  const width = o.width ?? gutter + cols.length * cell + 12;
  const height = o.height ?? topLabels + rows.length * cell + 10;

  const flat = values.flat().filter((v) => Number.isFinite(v));
  const peak = Math.max(1, ...flat);

  const colLabels = cols
    .map((c, j) => {
      const x = gutter + j * cell + cell / 2;
      return `<text x="${n(x)}" y="${topLabels - 8}" class="tick" text-anchor="start" transform="rotate(-45 ${n(x)} ${topLabels - 8})">${esc(clip(c, 16))}</text>`;
    })
    .join("");

  const body = rows
    .map((r, i) => {
      const y = topLabels + i * cell;
      const label = `<text x="${gutter - 8}" y="${n(y + cell / 2 + 4)}" class="tick lbl" text-anchor="end">${esc(clip(r, 24))}</text>`;
      const cells = cols
        .map((c, j) => {
          const v = values[i]?.[j];
          if (!Number.isFinite(v)) return "";
          return (
            `<rect x="${n(gutter + j * cell)}" y="${n(y)}" width="${cell - 1}" height="${cell - 1}" rx="1" ` +
            `fill="${ramp((v as number) / peak)}"${
              o.clickable ? ` class="hit" data-key="${esc(r)}" data-key2="${esc(c)}"` : ""
            }><title>${esc(r)} × ${esc(c)}: ${esc(fmt(v as number))}</title></rect>`
          );
        })
        .join("");
      return label + cells;
    })
    .join("");

  return frame(colLabels + body, {
    width,
    height,
    minWidth: o.minWidth ?? Math.min(width, 640),
    ariaLabel: o.ariaLabel ?? "Matrix heatmap",
  });
}

export interface GaugeOptions {
  /** 0..1 */
  value: number;
  label: string;
  caption?: string;
  width?: number;
}

/** A single proportion, as a labelled bar. Used for full-text coverage. */
export function gauge(o: GaugeOptions): string {
  const width = o.width ?? 300;
  const t = Math.max(0, Math.min(1, o.value));
  return frame(
    `<rect x="0" y="10" width="${width}" height="14" rx="7" class="track"/>` +
      `<rect x="0" y="10" width="${n(width * t)}" height="14" rx="7" fill="${ramp(0.75)}"><title>${esc(o.label)}</title></rect>` +
      `<text x="0" y="6" class="tick">${esc(o.label)}</text>` +
      (o.caption ? `<text x="${width}" y="6" class="tick" text-anchor="end">${esc(o.caption)}</text>` : ""),
    { width, height: 30, minWidth: 200, ariaLabel: o.label },
  );
}

/** Colour key shared by every multi-series chart. */
export function legend(labels: string[], colors?: string[]): string {
  if (labels.length < 2) return "";
  const c = colors ?? palette();
  return `<ul class="legend">${labels
    .map(
      (l, i) =>
        `<li><span class="swatch" style="background:${c[i % c.length]}"></span>${esc(l)}</li>`,
    )
    .join("")}</ul>`;
}
