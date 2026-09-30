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
import { chips, empty, type BasePayload, type ViewContext, type ViewOptions, type ViewResult } from "./shell.js";
import { esc } from "./theme.js";
import { setTheme } from "./theme.js";
import { VIEWS } from "./views/index.js";
import { selectionFrom } from "../selection.js";
import { VIEW_DATA_META_KEY, isViewName } from "../viewContract.js";

const app = new App({ name: "IWAC charts", version: "3.0.0" });
const root = document.getElementById("root") as HTMLElement;

/** Last payload rendered, so a failed re-call can fall back to it. */
let current: BasePayload = {};
/** Message from the most recent failed re-call, shown above the retained chart. */
let transientError: string | null = null;
/** View-local UI state (see shell.ts), discarded whenever the view changes. */
let options: ViewOptions = {};
let optionsView: string | undefined;
let generation = 0;
const history: { payload: BasePayload; options: ViewOptions }[] = [];
function navigate(next: BasePayload): void {
  if (current.view) {
    history.push({ payload: current, options });
    if (history.length > 30) history.shift();
  }
  render(next);
}

// -----------------------------------------------------------------------------
// Payload plumbing
// -----------------------------------------------------------------------------

/**
 * Tools ship the same object as `structuredContent` AND as JSON text; prefer
 * the structured half and fall back so the app still works if that changes.
 * Error results carry only the text block, which is why the fallback matters.
 *
 * Chart-heavy tools additionally split their payload (see tools/_shared.ts
 * `viewResult`): the dense series a chart plots but a model cannot read travels
 * in `_meta` instead of being billed to the conversation. It is merged back in
 * here, so every view still receives ONE flat payload and none of them needs to
 * know the split exists. The view half wins on key collision, because it carries the
 * full series where the model half may hold only a summary of it.
 */
function readPayload(result: unknown): BasePayload {
  const r = result as {
    structuredContent?: BasePayload;
    content?: { type: string; text?: string }[];
    _meta?: Record<string, unknown>;
    isError?: boolean;
  };
  const viewData = r?._meta?.[VIEW_DATA_META_KEY] as BasePayload | undefined;
  const merge = (base: BasePayload): BasePayload => {
    const merged: BasePayload = { ...base, ...viewData, provenance: r?._meta?.["islam.zmo.de/provenance"] };
    if (!merged.view && typeof merged.text === "string" && merged.id) merged.view = "reader";
    return merged;
  };

  if (r?.structuredContent) return merge(r.structuredContent);
  const text = r?.content?.find((c) => c.type === "text")?.text;
  if (!text) return { error: "The tool returned no readable result." };
  try {
    return merge(JSON.parse(text) as BasePayload);
  } catch {
    return { error: "The tool result was not valid JSON." };
  }
}

const ctx: ViewContext = {
  async run(name, args) {
    const ticket = ++generation;
    root.setAttribute("aria-busy", "true");
    if (!root.querySelector(".loading")) {
      const status = document.createElement("p");
      status.className = "loading";
      status.setAttribute("role", "status");
      status.textContent = "Loading…";
      root.append(status);
    }
    try {
      const result = await app.callServerTool({ name, arguments: args });
      if (ticket !== generation) return;
      const next = readPayload(result);
      if (next.error) throw new Error(String(next.error));
      transientError = null;
      navigate(next);
    } catch (error) {
      if (ticket !== generation) return;
      transientError = (error as Error).message;
      render(current);
    } finally {
      if (ticket === generation) {
        root.removeAttribute("aria-busy");
        root.querySelector(".loading")?.remove();
      }
    }
  },
  setOption(key, value) {
    options = { ...options, [key]: value };
    render(current);
  },
  canDownload: false,
  canOpenLink: false,
  async download(filename, mimeType, text) {
    const contents = [{ type: "resource" as const, resource: { uri: `file:///${filename}`, mimeType, text } }];
    if (mimeType !== "application/json" && current.provenance)
      contents.push({
        type: "resource",
        resource: {
          uri: `file:///${filename}.provenance.json`,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              exported_at: new Date().toISOString(),
              provenance: current.provenance,
              filters: current.filters,
              note: current.note,
              offset: current.offset,
              has_more: current.has_more,
            },
            null,
            2,
          ),
        },
      });
    await app.downloadFile({ contents });
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

  // A new view means the previous one's options are meaningless.
  if (payload.view !== optionsView) {
    optionsView = payload.view;
    options = {};
  }

  const view = payload.view && isViewName(payload.view) ? VIEWS[payload.view] : undefined;
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
    result = view(payload, options);
  } catch (err) {
    root.innerHTML = empty(`Could not draw this chart: ${(err as Error).message}`);
    return;
  }

  const notes = (result.notes ?? [])
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .map((t) => `<p class="foot">${esc(t)}</p>`)
    .join("");

  const actions = (result.actions ?? []).filter((a) => a.id !== "csv" || ctx.canDownload);
  if (
    payload.subset &&
    payload.filters &&
    !["records", "reader", "aliases", "comparison"].includes(payload.view ?? "")
  ) {
    actions.unshift({
      id: "read-items",
      label: "Read source items",
      run: (c) =>
        c.run("explore_corpus", {
          mode: "items",
          subset: payload.subset,
          selection: selectionFrom(payload.filters as Record<string, unknown>),
        }),
    });
  }
  if (ctx.canDownload) {
    actions.push({
      id: "json",
      label: "Download data + provenance",
      run: (c) =>
        c.download(
          "iwac-research.json",
          "application/json",
          JSON.stringify({ exported_at: new Date().toISOString(), ...payload }, null, 2),
        ),
    });
    if (result.body.includes("<svg"))
      actions.push({
        id: "svg",
        label: "Download chart SVG",
        run: (c) => {
          const theme = document.documentElement.getAttribute("data-theme") ?? "light";
          const styles = document.querySelector("style")?.textContent ?? "";
          let y = 40,
            width = 900;
          const parts = Array.from(root.querySelectorAll("svg")).map((svg) => {
            const [, , w, h] = (svg.getAttribute("viewBox") ?? "0 0 900 300").split(/\s+/).map(Number);
            width = Math.max(width, w);
            const top = y;
            y += h + 40;
            return `<text x="10" y="${top}" fill="var(--fg)" font-size="14">${esc(svg.getAttribute("aria-label") ?? "")}</text><svg x="0" y="${top + 10}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${svg.innerHTML}</svg>`;
          });
          const svg = `<svg xmlns="http://www.w3.org/2000/svg" data-theme="${theme}" viewBox="0 0 ${width} ${y}" width="${width}" height="${y}" style="font-family:system-ui,sans-serif"><style>${styles}</style><rect width="100%" height="100%" fill="${theme === "dark" ? "#17130f" : "#ffffff"}"/><title>${esc(result.title)}</title>${parts.join("")}</svg>`;
          return c.download("iwac-chart.svg", "image/svg+xml", svg);
        },
      });
  }
  if (history.length)
    actions.unshift({
      id: "back",
      label: "Back",
      run: () => {
        generation++;
        const previous = history.pop();
        if (!previous) return;
        options = previous.options;
        optionsView = previous.payload.view;
        transientError = null;
        render(previous.payload);
      },
    });

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
  root.querySelectorAll<SVGElement>("[data-key]").forEach((el) => {
    el.setAttribute("tabindex", "0");
    el.setAttribute("role", "button");
    el.setAttribute(
      "aria-label",
      el.querySelector("title")?.textContent ?? el.getAttribute("data-key") ?? "Inspect sources",
    );
    el.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
    });
  });
}

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------

app.ontoolresult = (result) => {
  generation++;
  history.length = 0;
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
