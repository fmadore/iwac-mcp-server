// Browser side of every IWAC MCP App chart.
//
// ONE resource (`ui://iwac/charts.html`) serves all of them. Each `ui://`
// resource is a standalone HTML document that can share nothing with its
// siblings, so N resources means N copies of the MCP SDK and zod — ~190 kb
// each, against ~4 kb for the chart that actually differs. Many tools may
// point `_meta.ui.resourceUri` at the SAME resource, so the suite costs one
// SDK copy in total; see docs/mcp-apps-roadmap.md §2.2.
//
// The cost of that decision is this file: a document that branches on payload
// shape. It is kept honest by pushing everything shape-specific into
// views/*.ts, which are pure functions this module renders — the dispatch
// below is the only place that knows more than one chart exists.
//
// Bundled to a single IIFE and inlined into one HTML string at build time
// (scripts/bundle.mjs) because MCP App resources render under a deny-by-default
// CSP: no external stylesheet, font, or script may load.
import { App } from "@modelcontextprotocol/ext-apps";
import { chips, empty, type BasePayload, type ViewContext, type ViewResult } from "./shell.js";
import { esc } from "./theme.js";
import { setTheme } from "./theme.js";
import { VIEWS } from "./views/index.js";

const app = new App({ name: "IWAC charts", version: "2.0.0" });
const root = document.getElementById("root") as HTMLElement;

/** Last payload rendered, so a failed re-call can fall back to it. */
let current: BasePayload = {};
/** Message from the most recent failed re-call, shown above the retained chart. */
let transientError: string | null = null;

// -----------------------------------------------------------------------------
// Payload plumbing
// -----------------------------------------------------------------------------

/**
 * Tools ship the same object as `structuredContent` AND as JSON text; prefer
 * the structured half and fall back so the app still works if that changes.
 * Error results carry only the text block, which is why the fallback matters.
 */
function readPayload(result: unknown): BasePayload {
  const r = result as {
    structuredContent?: BasePayload;
    content?: { type: string; text?: string }[];
    isError?: boolean;
  };
  if (r?.structuredContent) return r.structuredContent;
  const text = r?.content?.find((c) => c.type === "text")?.text;
  if (!text) return { error: "The tool returned no readable result." };
  try {
    return JSON.parse(text) as BasePayload;
  } catch {
    return { error: "The tool result was not valid JSON." };
  }
}

const ctx: ViewContext = {
  async run(name, args) {
    const result = await app.callServerTool({ name, arguments: args });
    const next = readPayload(result);
    if (next.error) {
      // Keep the chart the user is looking at rather than replacing it with an
      // error page; a rejected group_by should not cost them their place.
      transientError = String(next.error);
      render(current);
      return;
    }
    transientError = null;
    render(next);
  },
  canDownload: false,
  canOpenLink: false,
  async download(filename, mimeType, text) {
    await app.downloadFile({
      contents: [{ type: "resource", resource: { uri: `file:///${filename}`, mimeType, text } }],
    });
  },
  async openLink(url) {
    await app.openLink({ url });
  },
};

// -----------------------------------------------------------------------------
// Render
// -----------------------------------------------------------------------------

function render(payload: BasePayload): void {
  current = payload;

  if (payload.error) {
    root.innerHTML = empty(String(payload.error));
    return;
  }

  const view = payload.view ? VIEWS[payload.view] : undefined;
  if (!view) {
    // A tool declared this resource but its payload carries no view this bundle
    // knows — most likely a server newer than the packaged UI. Say which.
    root.innerHTML = empty(
      payload.view
        ? `This chart bundle has no view named "${payload.view}". Update the IWAC extension.`
        : "This result carries no chart view.",
    );
    return;
  }

  let result: ViewResult;
  try {
    result = view(payload);
  } catch (err) {
    root.innerHTML = empty(`Could not draw this chart: ${(err as Error).message}`);
    return;
  }

  const notes = (result.notes ?? [])
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .map((t) => `<p class="foot">${esc(t)}</p>`)
    .join("");

  const actions = (result.actions ?? []).filter((a) => a.id !== "csv" || ctx.canDownload);

  root.innerHTML = `
    <header>
      <h1>${esc(result.title)}</h1>
      ${result.subtitle ? `<p class="totals">${result.subtitle}</p>` : ""}
      ${result.chips === undefined ? "" : `<div class="chips">${chips(result.chips)}</div>`}
    </header>
    ${transientError ? `<p class="warn">${esc(transientError)}</p>` : ""}
    <div class="chart">${result.body}</div>
    ${notes}
    ${
      actions.length
        ? `<div class="actions">${actions
            .map((a) => `<button id="act-${esc(a.id)}" type="button">${esc(a.label)}</button>`)
            .join("")}</div>`
        : ""
    }
  `;

  for (const action of actions) {
    const button = document.getElementById(`act-${action.id}`) as HTMLButtonElement | null;
    button?.addEventListener("click", async () => {
      const label = button.textContent;
      button.disabled = true;
      button.textContent = action.busyLabel ?? "Loading…";
      try {
        await action.run(ctx);
      } catch (err) {
        // render() replaces the whole subtree on success, so only a genuine
        // failure reaches here and the button is still on screen to restore.
        button.disabled = false;
        button.textContent = `${label} — failed (${(err as Error).message})`;
      }
    });
  }

  result.wire?.(root, ctx);
}

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------

app.ontoolresult = (result) => {
  transientError = null;
  render(readPayload(result));
};

// The host tells the app which theme it is being rendered into. That beats
// `prefers-color-scheme`, which inside a sandboxed iframe reports the OS
// preference rather than the host app's — the two disagree whenever the user
// has overridden the theme in Claude.
app.onhostcontextchanged = (context) => {
  if (context.theme) {
    setTheme(context.theme);
    if (current.view) render(current);
  }
};

setTheme(undefined);
app
  .connect()
  .then(() => {
    const host = app.getHostContext();
    setTheme(host?.theme);
    const caps = app.getHostCapabilities();
    ctx.canDownload = Boolean(caps?.downloadFile);
    ctx.canOpenLink = Boolean(caps?.openLinks);
    // The tool result usually arrives after connect(), but a host that
    // delivered it first would have rendered with the wrong theme and without
    // the capability-gated actions.
    if (current.view) render(current);
  })
  .catch((err) => {
    root.innerHTML = empty(`Could not connect to the host: ${(err as Error).message}`);
  });
