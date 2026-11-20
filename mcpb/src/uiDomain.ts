// The sandbox origin Claude serves an MCP App view from (`_meta.ui.domain`).
//
// Without the field Claude gives the chart view a different sandbox host in
// every conversation, so nothing the view stores survives and no site can name
// it in `frame-ancestors`. With it the host is fixed: the first 32 hex
// characters of the SHA-256 of the connector URL, then `.claudemcpcontent.com`.
//
// The catch is that Claude hashes the URL exactly as the user typed it in
// Customize > Connectors, trailing slash included, and shows an error instead
// of the view when the value does not match. The hosted endpoint answers both
// `https://islam.zmo.de/mcp` and `https://islam.zmo.de/mcp/`, and the docs
// have advertised both, so one fixed value would break the charts for half the
// users. The value is therefore worked out per request: the public URL's
// scheme, host and mount (IWAC_MCP_PUBLIC_URL, since behind nginx the process
// cannot see them) plus the trailing slash of the path this request came in
// on, which nginx passes through unchanged.
//
// stdio (Claude Desktop's local extension) has no connector URL, so it never
// sets the field. IWAC_MCP_UI_DOMAIN=false turns it off over HTTP too: the
// spec leaves the field's format to each host, and a host other than Claude
// that rejects a Claude-shaped value can be served without it.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

const connectorUrlStore = new AsyncLocalStorage<string | undefined>();

/** Claude's sandbox host for a connector URL, hashed exactly as given. */
export function claudeSandboxDomain(connectorUrl: string): string {
  return `${createHash("sha256").update(connectorUrl).digest("hex").slice(0, 32)}.claudemcpcontent.com`;
}

/**
 * The URL a client typed to reach this request: the public URL (as
 * parsePublicUrl normalised it, without a trailing slash) with the request
 * path's own trailing slash, if any.
 */
export function connectorUrlFor(publicUrl: string, requestPath: string): string {
  const base = publicUrl.replace(/\/+$/, "");
  return requestPath.endsWith("/") ? `${base}/` : base;
}

/** Run `fn` with the connector URL of the request it serves in scope. */
export function withConnectorUrl<T>(connectorUrl: string | undefined, fn: () => T): T {
  return connectorUrlStore.run(connectorUrl, fn);
}

/** `_meta.ui.domain` for the request in scope, or undefined outside one. */
export function currentUiDomain(): string | undefined {
  const url = connectorUrlStore.getStore();
  return url === undefined ? undefined : claudeSandboxDomain(url);
}
