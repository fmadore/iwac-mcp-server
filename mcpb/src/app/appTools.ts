// Tools the chart view registers for the assistant: Claude's "app tools".
//
// A host that supports them (Claude, for remote connectors) lists these beside
// the server's own tools while the view is open and asks the user before each
// call. They let the assistant work IN the open view instead of starting a new
// one for every step: read what is on screen, press one of its buttons, open
// the sources behind a bar or a map country, or load another IWAC result into
// the same frame, where Back still returns to the previous selection.
//
// They act only through what a person could do in the view. Every follow-up
// query goes through the same `callServerTool` path as a click, so the server
// sees nothing new, and the buttons a model must not press are refused here:
// sending a chat message (the assistant would be talking to itself), the
// display-mode toggle (hosts require a real click), and downloads or opening
// links (a file or a new tab the user did not ask for).
//
// Claude reads the `text` of a result and ignores `structuredContent` when text
// is present, so every result is text: the view's current selection summary,
// the same one automatic context sharing sends. Definitions are fixed: Claude
// asks for approval again whenever a name, title, description or schema
// changes, so anything that varies (the marks, the buttons) is returned in
// results, never put in a description.
import type { App } from "@modelcontextprotocol/ext-apps";
import { z } from "zod/v4";

export interface ViewToolResult {
  text: string;
  isError?: boolean;
}

/** The view state and actions the tools need, implemented by charts.ts. */
export interface ViewDriver {
  /** The current selection summary, or an error when nothing is drawn. */
  describe(): ViewToolResult;
  /** Chart marks a click would open, as `data-key` and accessible label. */
  marks(): { key: string; label: string }[];
  /** Buttons the assistant may press, by id and label. */
  actions(): { id: string; label: string }[];
  runAction(id: string): Promise<ViewToolResult>;
  openMark(key: string): Promise<ViewToolResult>;
  show(tool: string, args: Record<string, unknown>): Promise<ViewToolResult>;
}

/** Largest number of marks listed; a heatmap can hold several hundred cells. */
export const MAX_LISTED_MARKS = 120;

const text = (result: ViewToolResult) => ({
  content: [{ type: "text" as const, text: result.text }],
  ...(result.isError ? { isError: true } : {}),
});

function inventory(driver: ViewDriver): string {
  const actions = driver.actions();
  const marks = driver.marks();
  const lines = [
    actions.length
      ? `Buttons (run_view_action id): ${actions.map((a) => `${a.id} = "${a.label}"`).join("; ")}`
      : "Buttons: none the assistant may press.",
    marks.length
      ? `Chart marks (open_chart_mark key), ${marks.length > MAX_LISTED_MARKS ? `first ${MAX_LISTED_MARKS} of ${marks.length}` : marks.length}:\n` +
        marks
          .slice(0, MAX_LISTED_MARKS)
          .map((m) => `- ${m.key}: ${m.label}`)
          .join("\n")
      : "Chart marks: none open sources in this view.",
  ];
  return lines.join("\n");
}

/** Register the view's tools. Must run before `app.connect()`. */
export function registerViewTools(app: App, driver: ViewDriver): void {
  app.registerTool(
    "describe_view",
    {
      title: "Read the open IWAC view",
      description:
        "Read what the open IWAC view shows: its selection summary, the buttons you may press and the chart marks you may open. Call before acting in the view.",
      annotations: { readOnlyHint: true },
    },
    () => {
      const state = driver.describe();
      return text(state.isError ? state : { text: `${state.text}\n\n${inventory(driver)}` });
    },
  );

  app.registerTool(
    "run_view_action",
    {
      title: "Press a button in the IWAC view",
      description:
        "Press one of the open view's buttons by id (from describe_view), such as back, read-items or an option toggle. Returns the selection now shown.",
      inputSchema: z.object({ id: z.string().min(1).max(64).describe("Button id from describe_view") }),
    },
    async ({ id }) => text(await driver.runAction(id)),
  );

  app.registerTool(
    "open_chart_mark",
    {
      title: "Open a chart mark in the IWAC view",
      description:
        "Open the drill-down behind one chart mark (a bar, cell, country or point) by key, as a click would. Keys come from describe_view. Returns the selection now shown.",
      inputSchema: z.object({ key: z.string().min(1).max(500).describe("Mark key from describe_view") }),
    },
    async ({ key }) => text(await driver.openMark(key)),
  );

  app.registerTool(
    "show_result",
    {
      title: "Show an IWAC result in the open view",
      description:
        "Run an IWAC chart tool (e.g. get_temporal_distribution, explore_corpus, fetch) and show its result in the open view, keeping Back history. Same arguments as calling the tool directly.",
      inputSchema: z.object({
        tool: z.string().regex(/^[a-z_]{1,64}$/).describe("IWAC tool name"),
        arguments: z.record(z.string(), z.unknown()).optional().describe("That tool's arguments"),
      }),
    },
    async ({ tool, arguments: args }) => text(await driver.show(tool, args ?? {})),
  );
}
