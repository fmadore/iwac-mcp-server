// Colour, theme and text helpers shared by every IWAC chart view.
//
// Split out of the original coverage.ts so the palette lives in exactly one
// place: it is copied from the IwacVisualizations Omeka module and drifts
// silently if the module's changes. See docs/mcp-apps-roadmap.md §7.

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

/** Endpoints of the sequential ramp used by heatmaps and gauges. */
const RAMP = {
  light: { from: "#f2ede8", to: "#ce4115" },
  dark: { from: "#241d17", to: "#ec653f" },
};

let dark = false;

/**
 * Adopt the host's declared theme. MCP hosts send `theme` in the initialize
 * handshake and again on every change, which is more reliable than
 * `prefers-color-scheme` inside a sandboxed iframe — the iframe inherits the
 * OS preference, not the host app's, and the two disagree whenever the user
 * has overridden the theme in Claude.
 */
export function setTheme(theme: string | undefined): void {
  dark = theme === "dark" || (theme === undefined && matchesDarkMedia());
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

function matchesDarkMedia(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

export const isDark = (): boolean => dark;

/** Categorical colours, in the order series should consume them. */
export const palette = (): string[] => [...(dark ? BRAND.dark : BRAND.light), ...PALETTE_REST];

/** One stable colour per name, so a country keeps its hue across charts. */
export function colorFor(name: string, order: string[]): string {
  const colors = palette();
  const i = order.indexOf(name);
  return colors[(i < 0 ? order.length : i) % colors.length];
}

const hex = (c: string): [number, number, number] => [
  Number.parseInt(c.slice(1, 3), 16),
  Number.parseInt(c.slice(3, 5), 16),
  Number.parseInt(c.slice(5, 7), 16),
];

/**
 * Sequential ramp position `t` in [0, 1]. Interpolated in plain sRGB: the
 * ramps below are short and low-chroma enough that the usual sRGB-blending
 * complaint (a muddy midpoint) does not show up, and a perceptual space would
 * cost more code than a heatmap legend is worth.
 */
export function ramp(t: number): string {
  const { from, to } = dark ? RAMP.dark : RAMP.light;
  const a = hex(from);
  const b = hex(to);
  const clamped = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  const mix = a.map((v, i) => Math.round(v + (b[i] - v) * clamped));
  return `rgb(${mix[0]},${mix[1]},${mix[2]})`;
}

// -----------------------------------------------------------------------------
// Text
// -----------------------------------------------------------------------------

/** Escape for both text nodes and attribute values (quotes included). */
export const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Thousands separators, without depending on the iframe's locale — that is the
 * HOST's locale, not the corpus's, and would render a francophone collection's
 * counts as "12,287".
 *
 * The separator is U+202F NARROW NO-BREAK SPACE: the French convention these
 * charts should follow, and no-break so a count never wraps mid-number inside
 * an SVG label. Exported so tests can assert it without a lookalike literal.
 */
export const THOUSANDS_SEP = " ";

export function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const neg = n < 0;
  const digits = Math.round(Math.abs(n)).toString();
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += THOUSANDS_SEP;
    out += digits[i];
  }
  return neg ? `-${out}` : out;
}

/** Fixed-precision float that drops a trailing ".0". */
export function fmtNum(n: number, places = 2): string {
  if (!Number.isFinite(n)) return "—";
  return Number.parseFloat(n.toFixed(places)).toString();
}

export const fmtPct = (t: number): string => `${fmtNum(t * 100, 1)}%`;

/** Truncate for an axis label, keeping the ellipsis inside the budget. */
export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1))}…`;
}
