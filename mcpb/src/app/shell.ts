// The page chrome every IWAC chart view shares, plus the view contract itself.
//
// A view is a pure function from a tool payload to a {title, body, notes,
// actions} description. It never touches the DOM directly: charts.ts renders
// the description and wires the actions. That keeps views testable in Node
// (no DOM) and keeps the click/disable/error-recovery dance in one place
// instead of once per chart.
import { esc } from "./theme.js";

/**
 * Every UI-bearing tool tags its payload with `view`, and that tag is what
 * charts.ts dispatches on.
 *
 * The obvious alternative — reading the tool name from the host — does not
 * work: `ontoolresult` receives a bare CallToolResult with no tool name, and
 * `getHostContext().toolInfo` describes only the ONE call that instantiated
 * the app, not the later ones the app makes itself via `callServerTool`. A tag
 * that travels with the payload covers both paths identically, survives hosts
 * that strip unknown `_meta`, and doubles as a discriminant for any
 * programmatic client reading `structuredContent`.
 */
export interface BasePayload {
  view?: string;
  error?: string;
  note?: string;
  [key: string]: unknown;
}

export interface ViewContext {
  /** Call a server tool and render whatever payload comes back. */
  run(name: string, args: Record<string, unknown>): Promise<void>;
  /** Whether the host advertised `downloadFile`; actions gate themselves on it. */
  canDownload: boolean;
  /** Hand the user a file (CSV export). */
  download(filename: string, mimeType: string, text: string): Promise<void>;
  /** Whether the host advertised `openLinks`. */
  canOpenLink: boolean;
  openLink(url: string): Promise<void>;
}

export interface Action {
  id: string;
  label: string;
  /** Label shown while `run` is in flight. */
  busyLabel?: string;
  run(ctx: ViewContext): Promise<void> | void;
}

export interface ViewResult {
  title: string;
  /** One line under the title: totals, counts, the shape of the answer. */
  subtitle?: string;
  /** Rendered as filter chips; null/undefined/"" entries are dropped. */
  chips?: Record<string, unknown>;
  /** The chart itself (SVG plus any legend). */
  body: string;
  /** Caveats — undated items, coverage limits, capped top-N. */
  notes?: (string | undefined | null | false)[];
  actions?: Action[];
  /** Attach delegated listeners for in-chart clicks. */
  wire?(root: HTMLElement, ctx: ViewContext): void;
}

export type View = (payload: BasePayload) => ViewResult;

/** Filter chips, skipping empty values; renders a muted placeholder if none. */
export function chips(values: Record<string, unknown> | undefined): string {
  const entries = Object.entries(values ?? {}).filter(
    ([, v]) => v !== null && v !== undefined && v !== "" && v !== false,
  );
  if (!entries.length) return '<span class="chip muted">no filters</span>';
  return entries.map(([k, v]) => `<span class="chip">${esc(k)}: ${esc(v)}</span>`).join("");
}

/** The empty state — a real sentence, not a blank panel. */
export const empty = (message: string): string => `<p class="empty">${esc(message)}</p>`;

/**
 * A CSV cell. Quotes anything containing a delimiter, quote or newline, and
 * prefixes the formula-injection characters so a spreadsheet treats an
 * exported title like `=cmd` as text.
 */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export const csv = (rows: unknown[][]): string => rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
